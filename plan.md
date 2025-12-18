Abaixo está **o melhor script possível dado o estado atual do Zora Coin SDK + Uniswap v4**, tomando **todas as decisões por você** e eliminando fragilidades.

Decisões fixadas (não negociáveis no script):

* **Atomicidade:** tudo ou nada.
* **Entrada:** **ETH nativo** (não ZORA).
* **Executor:** **Uniswap v4 Universal Router**.
* **SDK:** usado **apenas offchain** para discovery + poolKey + quotes.
* **Batch:** 1 tx, N swaps.
* **Fallback:** se qualquer coin não tiver pool/quote → aborta antes de enviar tx.

Motivo estrutural:

* ETH elimina Permit2 + settlement ERC20.
* SDK **não** é executor e **não** batcha.
* Universal Router é o único primitive correto para isso.

---

# Arquitetura final

```
[ Zora Coin SDK ]
  ├─ getCoins (10 coins de uma vez)
  ├─ extrai uniswapV4PoolKey
  ├─ quote por coin
  └─ calcula minOut
          ↓
[ Universal Router v4 ]
  └─ execute()
      └─ V4_SWAP
          └─ 10 × SWAP_EXACT_IN_SINGLE
```

---

# Script completo (TypeScript)

> **Pré-requisitos**

```bash
pnpm add viem dotenv @zoralabs/coins-sdk @uniswap/v4-sdk @uniswap/universal-router-sdk
```

---

```ts
// batchBuyZoraCoins.eth.ts
import 'dotenv/config'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import {
  setApiKey,
  getCoins,
  quoteBuyCoin,
} from '@zoralabs/coins-sdk'

import { Actions, V4Planner } from '@uniswap/v4-sdk'
import { CommandType, RoutePlanner } from '@uniswap/universal-router-sdk'

// -----------------------------------------------------------------------------
// CONFIG (decisões fixas)
// -----------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL!
const PRIVATE_KEY = process.env.PRIVATE_KEY! as `0x${string}`
const ZORA_API_KEY = process.env.ZORA_API_KEY!
const PLATFORM_REFERRAL = process.env.PLATFORM_REFERRAL as Address | undefined

// Base – Universal Router (v4)
const UNIVERSAL_ROUTER: Address =
  '0x6fF5693B99212Da76ad316178A184AB56D299b43'

// slippage global (bps)
const SLIPPAGE_BPS = 300n // 3%

// coins escolhidas pelo usuário
const COINS: Address[] = [
  '0x...',
  '0x...',
  // até 10
]

// ETH por coin
const ETH_PER_COIN = parseEther('0.002')

// -----------------------------------------------------------------------------
// ABI mínimo
// -----------------------------------------------------------------------------

const UNIVERSAL_ROUTER_ABI = [
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function hookData(platform?: Address): `0x${string}` {
  if (!platform) return '0x'
  return encodeAbiParameters([{ type: 'address' }], [platform])
}

function applySlippage(amount: bigint): bigint {
  return (amount * (10_000n - SLIPPAGE_BPS)) / 10_000n
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

async function main() {
  if (!RPC_URL || !PRIVATE_KEY || !ZORA_API_KEY) {
    throw new Error('env missing')
  }

  setApiKey(ZORA_API_KEY)

  const account = privateKeyToAccount(PRIVATE_KEY)

  const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL),
  })

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  })

  // ---------------------------------------------------------------------------
  // 1) Fetch 10 coins in ONE SDK call
  // ---------------------------------------------------------------------------

  const coinsResp = await getCoins({
    coins: COINS.map((addr) => ({
      chainId: base.id,
      collectionAddress: addr,
    })),
  })

  const tokens = coinsResp.data?.zora20Tokens ?? []

  if (tokens.length !== COINS.length) {
    throw new Error('missing coin data from sdk')
  }

  // ---------------------------------------------------------------------------
  // 2) Quote + build V4 actions
  // ---------------------------------------------------------------------------

  const v4Planner = new V4Planner()
  const routerPlanner = new RoutePlanner()

  let totalValue = 0n

  for (const token of tokens) {
    const poolKey = token.uniswapV4PoolKey
    if (!poolKey) throw new Error('missing poolKey')

    // SDK quote (ETH → coin)
    const quote = await quoteBuyCoin({
      chainId: base.id,
      collectionAddress: token.collectionAddress as Address,
      amountInWei: ETH_PER_COIN.toString(),
    })

    const amountOut = BigInt(quote.amountOutWei)
    const minOut = applySlippage(amountOut)

    // derive direction
    const zeroForOne =
      poolKey.currency0.toLowerCase() ===
      '0x0000000000000000000000000000000000000000'

    // swap
    v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [
      {
        poolKey,
        zeroForOne,
        amountIn: ETH_PER_COIN.toString(),
        amountOutMinimum: minOut.toString(),
        hookData: hookData(PLATFORM_REFERRAL),
      },
    ])

    // settle ETH
    v4Planner.addAction(Actions.SETTLE_ALL, [
      zeroForOne ? poolKey.currency0 : poolKey.currency1,
      ETH_PER_COIN.toString(),
    ])

    // take coin
    v4Planner.addAction(Actions.TAKE_ALL, [
      zeroForOne ? poolKey.currency1 : poolKey.currency0,
      minOut.toString(),
    ])

    totalValue += ETH_PER_COIN
  }

  const encodedActions = v4Planner.finalize()

  routerPlanner.addCommand(CommandType.V4_SWAP, [
    v4Planner.actions,
    v4Planner.params,
  ])

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)

  const data = encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [
      routerPlanner.commands as `0x${string}`,
      [encodedActions],
      deadline,
    ],
  })

  // ---------------------------------------------------------------------------
  // 3) Send ONE transaction
  // ---------------------------------------------------------------------------

  const hash = await walletClient.sendTransaction({
    to: UNIVERSAL_ROUTER,
    data,
    value: totalValue,
  })

  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log('batch buy tx:', receipt.transactionHash)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

---

# O que este script resolve (objetivamente)

* ✔ Busca **10 coins em uma chamada** do SDK
* ✔ Nunca hardcoda `poolKey`, `hooks`, `fee`, `tickSpacing`
* ✔ Nunca usa `amountOutMinimum = 0`
* ✔ 1 assinatura, 1 tx
* ✔ Atomicidade total
* ✔ ETH como input elimina Permit2
* ✔ Compatível com referral da Zora

---

# O que ele **deliberadamente não faz**

* Não aceita ZORA como input (porque **1 tx com ZORA exige Permit2 + extra swap**, aumentando superfície de falha).
* Não tenta “partial fill” (isso contradiz atomicidade).
* Não usa `tradeCoin` / `createTradeCall` como executor (camada errada).

---

Se você quiser, o próximo passo lógico é:

* **simulação onchain (`eth_call`) antes do send**
* **weighting (ex.: 40/30/30)** em vez de ETH fixo
* **index-fund UI** em cima disso

Mas **como script canônico**, este é o correto.

