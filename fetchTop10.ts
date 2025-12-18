import 'dotenv/config'
import { setApiKey, getCoinsMostValuable } from '@zoralabs/coins-sdk'
import { base } from 'viem/chains'

async function main() {
  setApiKey(process.env.ZORA_API_KEY!)

  const resp = await getCoinsMostValuable({
    chainIds: [base.id],
    count: 10,
  })

  const coins = resp.data?.exploreList?.edges ?? []

  console.log('Top 10 Zora Coins por Market Cap:\n')

  for (const edge of coins) {
    const coin = edge.node
    console.log(`${coin.name} (${coin.symbol})`)
    console.log(`  Address: ${coin.address}`)
    console.log(`  Market Cap: $${Number(coin.marketCap) / 1e6}M`)
    console.log('')
  }

  console.log('\n// Para copiar no script:')
  console.log('const COINS: Address[] = [')
  for (const edge of coins) {
    console.log(`  '${edge.node.address}',`)
  }
  console.log(']')
}

main().catch(console.error)
