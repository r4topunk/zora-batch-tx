// batchBuyZoraCoins.eth.ts
// Batch buy de Zora coins usando createTradeCall do SDK
import 'dotenv/config'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
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

// ETH por coin
const ETH_PER_COIN = parseEther('0.0001')

// Slippage (0.03 = 3%)
const SLIPPAGE = 0.03

// Numero de coins para comprar
const NUM_COINS = 10

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
  // 2) Comprar cada coin
  // ---------------------------------------------------------------------------

  const results: { coin: string; hash?: string; error?: string }[] = []
  let successCount = 0
  let totalSpent = 0n

  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i].node
    console.log(`[${i + 1}/${coins.length}] ${coin.name} (${coin.symbol})`)
    console.log(`    Address: ${coin.address}`)

    try {
      // Obter quote e call data do SDK
      const tradeParams: TradeParameters = {
        sell: { type: 'eth' },
        buy: { type: 'erc20', address: coin.address as Address },
        amountIn: ETH_PER_COIN,
        slippage: SLIPPAGE,
        sender: account.address,
      }

      const quoteResp = await createTradeCall(tradeParams)

      if (!quoteResp.success) {
        throw new Error('Quote failed')
      }

      const amountOut = quoteResp.quote.amountOut
      console.log(`    Quote: ~${Number(amountOut).toLocaleString()} tokens`)

      // Enviar transacao
      const hash = await walletClient.sendTransaction({
        to: quoteResp.call.target as Address,
        data: quoteResp.call.data as Hex,
        value: BigInt(quoteResp.call.value),
      })

      console.log(`    Tx: ${hash}`)

      // Aguardar confirmacao
      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success') {
        console.log(`    Status: SUCCESS`)
        successCount++
        totalSpent += ETH_PER_COIN
        results.push({ coin: coin.name, hash })
      } else {
        console.log(`    Status: FAILED`)
        results.push({ coin: coin.name, error: 'Transaction reverted' })
      }
    } catch (error: any) {
      console.log(`    Error: ${error.message || error}`)
      results.push({ coin: coin.name, error: error.message || 'Unknown error' })
    }

    console.log('')
  }

  // ---------------------------------------------------------------------------
  // 3) Resumo
  // ---------------------------------------------------------------------------

  console.log('='.repeat(60))
  console.log('RESUMO')
  console.log('='.repeat(60))
  console.log(`Coins compradas: ${successCount}/${coins.length}`)
  console.log(`Total gasto: ${Number(totalSpent) / 1e18} ETH`)
  console.log('')

  if (results.some((r) => r.error)) {
    console.log('Erros:')
    for (const r of results.filter((r) => r.error)) {
      console.log(`  - ${r.coin}: ${r.error}`)
    }
  }
}

main().catch((e) => {
  console.error('Error:', e.message || e)
  process.exit(1)
})
