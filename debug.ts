import 'dotenv/config'
import { setApiKey, getCoins, getCoinsMostValuable } from '@zoralabs/coins-sdk'
import { base } from 'viem/chains'

async function main() {
  setApiKey(process.env.ZORA_API_KEY!)

  // Verificar estrutura do explore
  console.log('=== Verificando getCoinsMostValuable ===')
  const exploreResp = await getCoinsMostValuable({
    chainIds: [base.id],
    count: 2,
  })

  const firstCoin = exploreResp.data?.exploreList?.edges?.[0]?.node
  console.log('Primeiro coin (explore):')
  console.log(JSON.stringify(firstCoin, null, 2))

  // Verificar estrutura do getCoins
  console.log('\n=== Verificando getCoins ===')
  const coinsResp = await getCoins({
    coins: [{ chainId: base.id, collectionAddress: '0xd769d56f479e9e72a77bb1523e866a33098feec5' }],
  })

  const token = coinsResp.data?.zora20Tokens?.[0]
  console.log('Primeiro token (getCoins):')
  console.log(JSON.stringify(token, null, 2))
}

main().catch(console.error)
