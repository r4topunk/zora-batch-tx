// batchSell0x.ts
// Batch sell de tokens usando 0x API v2
import 'dotenv/config'
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  type Address,
  type Hex,
  erc20Abi,
  formatUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL!
const PRIVATE_KEY = process.env.PRIVATE_KEY! as `0x${string}`
const ZeroX_API_KEY = process.env.ZeroX_API_KEY!

// Multicall3 na Base
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

// ETH nativo (endereço especial para 0x API)
const ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// 0x AllowanceHolder (para aprovar tokens na v2)
const ZEROX_ALLOWANCE_HOLDER: Address = '0x0000000000001fF3684f28c67538d4D072C22734'

// Slippage (1%)
const SLIPPAGE_BPS = 100

// Tokens para vender (adicionar endereços aqui)
const TOKENS_TO_SELL: Address[] = [
  '0x47c3e9e8b3f9c002e65a2d5e0cff948723f810c3',
  // Adicione mais tokens aqui
]

// Vender todo o balance? Se false, especificar SELL_AMOUNT
const SELL_ALL = true

// Quantidade a vender (só usado se SELL_ALL = false)
// const SELL_AMOUNT = parseUnits('100', 18)

// 0x API base URL
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
  if (!RPC_URL || !PRIVATE_KEY || !ZeroX_API_KEY) {
    throw new Error('env missing: RPC_URL, PRIVATE_KEY, ou ZeroX_API_KEY')
  }

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

  console.log(`Wallet: ${account.address}\n`)
  console.log(`Tokens para vender: ${TOKENS_TO_SELL.length}\n`)

  // ---------------------------------------------------------------------------
  // 1) Verificar balances e aprovar tokens
  // ---------------------------------------------------------------------------

  console.log('Verificando balances e aprovações...\n')

  const tokensWithBalance: { address: Address; balance: bigint; decimals: number; symbol: string }[] = []

  for (const tokenAddress of TOKENS_TO_SELL) {
    try {
      // Get balance
      const balance = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      })

      if (balance === 0n) {
        console.log(`  ⚠️ ${tokenAddress.slice(0, 10)}...: Balance = 0, skipping`)
        continue
      }

      // Get decimals and symbol
      const [decimals, symbol] = await Promise.all([
        publicClient.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'decimals',
        }),
        publicClient.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'symbol',
        }).catch(() => 'UNKNOWN'),
      ])

      console.log(`  ✓ ${symbol}: ${formatUnits(balance, decimals)} tokens`)

      // Check allowance
      const allowance = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account.address, ZEROX_ALLOWANCE_HOLDER],
      })

      if (allowance < balance) {
        console.log(`    → Aprovando ${symbol} para 0x AllowanceHolder...`)
        const approveTx = await walletClient.writeContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args: [ZEROX_ALLOWANCE_HOLDER, balance * 2n], // Aprovar 2x para margem
        })
        await publicClient.waitForTransactionReceipt({ hash: approveTx })
        console.log(`    ✓ Aprovado`)
      }

      tokensWithBalance.push({ address: tokenAddress, balance, decimals, symbol })
    } catch (error: any) {
      console.log(`  ❌ ${tokenAddress.slice(0, 10)}...: ${error.message}`)
    }
  }

  if (tokensWithBalance.length === 0) {
    throw new Error('Nenhum token com balance para vender')
  }

  // ---------------------------------------------------------------------------
  // 2) Obter quotes do 0x API para cada token
  // ---------------------------------------------------------------------------

  console.log('\nObtendo quotes do 0x API...\n')

  const calls: { target: Address; allowFailure: boolean; value: bigint; callData: Hex }[] = []
  let totalEthOut = 0n

  for (const token of tokensWithBalance) {
    try {
      const sellAmount = SELL_ALL ? token.balance : token.balance // TODO: suportar SELL_AMOUNT

      const quote = await get0xQuote(
        token.address,
        ETH_ADDRESS as Address,
        sellAmount,
        account.address
      )

      const ethOut = BigInt(quote.buyAmount)
      totalEthOut += ethOut

      console.log(`  ✓ ${token.symbol}: ${formatUnits(sellAmount, token.decimals)} → ~${formatUnits(ethOut, 18)} ETH`)

      calls.push({
        target: quote.transaction.to,
        allowFailure: false,
        value: BigInt(quote.transaction.value),
        callData: quote.transaction.data,
      })
    } catch (error: any) {
      console.log(`  ❌ ${token.symbol}: ${error.message}`)
    }
  }

  if (calls.length === 0) {
    throw new Error('No valid calls to execute')
  }

  // ---------------------------------------------------------------------------
  // 3) Executar vendas (uma por uma para simplicidade)
  // ---------------------------------------------------------------------------

  console.log(`\nExecutando ${calls.length} vendas...`)
  console.log(`ETH esperado: ~${formatUnits(totalEthOut, 18)} ETH\n`)

  let successCount = 0

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]
    const token = tokensWithBalance[i]

    try {
      console.log(`[${i + 1}/${calls.length}] Vendendo ${token.symbol}...`)

      const hash = await walletClient.sendTransaction({
        to: call.target,
        data: call.callData,
        value: call.value,
      })

      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success') {
        console.log(`  ✓ SUCCESS: ${hash}`)
        successCount++
      } else {
        console.log(`  ❌ FAILED: ${hash}`)
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`)
    }
  }

  // ---------------------------------------------------------------------------
  // 4) Resultado
  // ---------------------------------------------------------------------------

  console.log('\n' + '='.repeat(60))
  console.log('RESULTADO')
  console.log('='.repeat(60))
  console.log(`Tokens vendidos: ${successCount}/${calls.length}`)
  console.log(`ETH recebido: ~${formatUnits(totalEthOut, 18)} ETH`)
}

main().catch((e) => {
  console.error('Error:', e.message || e)
  process.exit(1)
})
