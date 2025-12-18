// batchBuyMulticall.ts
// Batch buy de Zora coins em UMA única transação usando Multicall3
import 'dotenv/config'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import {
  setApiKey,
  getCoinsMostValuable,
  createTradeCall,
  type TradeParameters,
} from '@zoralabs/coins-sdk'

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL!
const PRIVATE_KEY = process.env.PRIVATE_KEY! as `0x${string}`
const ZORA_API_KEY = process.env.ZORA_API_KEY!

// Multicall3 na Base (mesmo endereço em todas as chains EVM)
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

// ETH por coin
const ETH_PER_COIN = parseEther('0.0001')

// Slippage (0.03 = 3%)
const SLIPPAGE = 0.03

// Numero de coins para comprar
const NUM_COINS = 10

// -----------------------------------------------------------------------------
// ABI Multicall3
// -----------------------------------------------------------------------------

const MULTICALL3_ABI = [
  {
    name: 'aggregate3Value',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

async function main() {
  if (!RPC_URL || !PRIVATE_KEY || !ZORA_API_KEY) {
    throw new Error('env missing: RPC_URL, PRIVATE_KEY, ou ZORA_API_KEY')
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
  // 1) Fetch top coins por market cap
  // ---------------------------------------------------------------------------

  console.log(`Fetching top ${NUM_COINS} coins por market cap...`)

  const exploreResp = await getCoinsMostValuable({
    chainIds: [base.id],
    count: NUM_COINS,
  })

  const coins = exploreResp.data?.exploreList?.edges ?? []

  if (coins.length === 0) {
    throw new Error('No coins found')
  }

  console.log(`Found ${coins.length} coins\n`)

  // ---------------------------------------------------------------------------
  // 2) Obter call data para cada coin
  // ---------------------------------------------------------------------------

  console.log('Obtendo quotes e preparando calls...\n')

  const calls: { target: Address; allowFailure: boolean; value: bigint; callData: Hex }[] = []
  let totalValue = 0n

  for (const edge of coins) {
    const coin = edge.node

    const tradeParams: TradeParameters = {
      sell: { type: 'eth' },
      buy: { type: 'erc20', address: coin.address as Address },
      amountIn: ETH_PER_COIN,
      slippage: SLIPPAGE,
      sender: account.address,
    }

    const quoteResp = await createTradeCall(tradeParams)

    if (!quoteResp.success) {
      console.log(`  ❌ ${coin.name}: Quote failed, skipping`)
      continue
    }

    const amountOut = quoteResp.quote.amountOut
    console.log(`  ✓ ${coin.name}: ~${Number(amountOut).toLocaleString()} tokens`)

    calls.push({
      target: quoteResp.call.target as Address,
      allowFailure: false, // Se um falhar, reverte tudo (atomicidade)
      value: BigInt(quoteResp.call.value),
      callData: quoteResp.call.data as Hex,
    })

    totalValue += BigInt(quoteResp.call.value)
  }

  if (calls.length === 0) {
    throw new Error('No valid calls to execute')
  }

  // ---------------------------------------------------------------------------
  // 3) Encode multicall
  // ---------------------------------------------------------------------------

  console.log(`\nPreparando batch com ${calls.length} swaps...`)
  console.log(`Total ETH: ${Number(totalValue) / 1e18} ETH`)

  const multicallData = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3Value',
    args: [calls],
  })

  // ---------------------------------------------------------------------------
  // 4) Simular antes de enviar
  // ---------------------------------------------------------------------------

  console.log('\nSimulando transação...')

  try {
    await publicClient.call({
      account: account.address,
      to: MULTICALL3,
      data: multicallData,
      value: totalValue,
    })
    console.log('✓ Simulação OK')
  } catch (error: any) {
    console.error('❌ Simulação falhou:', error.message || error)
    throw new Error('Simulação falhou - transação seria revertida')
  }

  // ---------------------------------------------------------------------------
  // 5) Enviar UMA única transação
  // ---------------------------------------------------------------------------

  console.log('\nEnviando transação...')

  const hash = await walletClient.sendTransaction({
    to: MULTICALL3,
    data: multicallData,
    value: totalValue,
  })

  console.log(`Tx hash: ${hash}`)
  console.log('Aguardando confirmação...')

  const receipt = await publicClient.waitForTransactionReceipt({ hash })

  // ---------------------------------------------------------------------------
  // 6) Resultado
  // ---------------------------------------------------------------------------

  console.log('\n' + '='.repeat(60))
  console.log('RESULTADO')
  console.log('='.repeat(60))
  console.log(`Status: ${receipt.status === 'success' ? '✓ SUCCESS' : '❌ FAILED'}`)
  console.log(`Hash: ${receipt.transactionHash}`)
  console.log(`Block: ${receipt.blockNumber}`)
  console.log(`Gas used: ${receipt.gasUsed.toString()}`)
  console.log(`Coins compradas: ${calls.length}`)
  console.log(`Total gasto: ${Number(totalValue) / 1e18} ETH`)
}

main().catch((e) => {
  console.error('Error:', e.message || e)
  process.exit(1)
})
