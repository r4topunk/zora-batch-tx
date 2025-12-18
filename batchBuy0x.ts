// batchBuy0x.ts
// Batch buy de Zora coins usando 0x API v2 (mesma rota do Matcha)
import 'dotenv/config'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  encodeFunctionData,
  type Address,
  type Hex,
  concat,
  numberToHex,
  size,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { signTypedData } from 'viem/accounts'

import {
  setApiKey,
  getCoinsMostValuable,
} from '@zoralabs/coins-sdk'

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL!
const PRIVATE_KEY = process.env.PRIVATE_KEY! as `0x${string}`
const ZORA_API_KEY = process.env.ZORA_API_KEY!
const ZeroX_API_KEY = process.env.ZeroX_API_KEY!

// Multicall3 na Base
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

// ETH nativo (endereço especial para 0x API)
const ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// ETH por coin
const ETH_PER_COIN = parseEther('0.00001')

// Slippage (0.01 = 1%)
const SLIPPAGE_BPS = 100 // 1% em basis points

// Numero de coins aleatorias para comprar
const NUM_RANDOM_COINS = 1

// Coins específicas para comprar (adicionar endereços aqui)
const SPECIFIC_COINS: Address[] = [
  '0x47c3e9e8b3f9c002e65a2d5e0cff948723f810c3',
]

// 0x API base URL (allowance-holder é mais simples para ETH->Token)
const ZEROX_API_URL = 'https://api.0x.org/swap/allowance-holder/quote'

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
// 0x API Types
// -----------------------------------------------------------------------------

interface ZeroXQuoteResponse {
  buyAmount: string
  sellAmount: string
  transaction: {
    to: Address
    data: Hex
    value: string
    gas: string
    gasPrice: string
  }
  permit2?: {
    eip712: any
  }
  issues?: {
    allowance?: any
    balance?: any
  }
}

// -----------------------------------------------------------------------------
// Helper: Get 0x Quote
// -----------------------------------------------------------------------------

async function get0xQuote(
  sellToken: Address,
  buyToken: Address,
  sellAmount: bigint,
  taker: Address
): Promise<ZeroXQuoteResponse> {
  const params = new URLSearchParams({
    chainId: base.id.toString(),
    sellToken,
    buyToken,
    sellAmount: sellAmount.toString(),
    taker,
    slippageBps: SLIPPAGE_BPS.toString(),
  })

  const response = await fetch(`${ZEROX_API_URL}?${params}`, {
    headers: {
      '0x-api-key': ZeroX_API_KEY,
      '0x-version': 'v2',
    },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`0x API error: ${response.status} - ${error}`)
  }

  return response.json()
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

async function main() {
  if (!RPC_URL || !PRIVATE_KEY || !ZORA_API_KEY || !ZeroX_API_KEY) {
    throw new Error('env missing: RPC_URL, PRIVATE_KEY, ZORA_API_KEY, ou ZeroX_API_KEY')
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
  // 1) Montar lista de coins para comprar
  // ---------------------------------------------------------------------------

  const coinAddresses: { address: Address; name: string }[] = []

  // Adicionar coins específicas
  for (const addr of SPECIFIC_COINS) {
    coinAddresses.push({ address: addr, name: addr.slice(0, 10) + '...' })
  }

  // Buscar coins aleatórias se necessário
  if (NUM_RANDOM_COINS > 0) {
    console.log(`Fetching top coins por market cap...`)

    const exploreResp = await getCoinsMostValuable({
      chainIds: [base.id],
      count: NUM_RANDOM_COINS + 5, // pegar mais para ter margem
    })

    const coins = exploreResp.data?.exploreList?.edges ?? []

    // Pegar aleatoriamente NUM_RANDOM_COINS
    const shuffled = coins.sort(() => Math.random() - 0.5)
    const selected = shuffled.slice(0, NUM_RANDOM_COINS)

    for (const edge of selected) {
      const coin = edge.node
      // Evitar duplicatas
      if (!coinAddresses.find(c => c.address.toLowerCase() === coin.address.toLowerCase())) {
        coinAddresses.push({ address: coin.address as Address, name: coin.name })
      }
    }
  }

  console.log(`Total: ${coinAddresses.length} coins para comprar\n`)

  // ---------------------------------------------------------------------------
  // 2) Obter quotes do 0x API para cada coin
  // ---------------------------------------------------------------------------

  console.log('Obtendo quotes do 0x API...\n')

  const calls: { target: Address; allowFailure: boolean; value: bigint; callData: Hex }[] = []
  let totalValue = 0n

  for (const coin of coinAddresses) {
    try {
      const quote = await get0xQuote(
        ETH_ADDRESS as Address,
        coin.address,
        ETH_PER_COIN,
        account.address
      )

      const buyAmount = BigInt(quote.buyAmount)
      console.log(`  ✓ ${coin.name}: ~${Number(buyAmount / 10n**18n).toLocaleString()} tokens`)

      calls.push({
        target: quote.transaction.to,
        allowFailure: false,
        value: BigInt(quote.transaction.value),
        callData: quote.transaction.data,
      })

      totalValue += BigInt(quote.transaction.value)
    } catch (error: any) {
      console.log(`  ❌ ${coin.name}: ${error.message}`)
    }
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
