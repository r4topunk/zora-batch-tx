import 'dotenv/config'
import { setApiKey, getCoinsMostValuable, createTradeCall, type TradeParameters } from '@zoralabs/coins-sdk'
import { base } from 'viem/chains'
import { parseEther, type Address, decodeAbiParameters } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

async function main() {
  setApiKey(process.env.ZORA_API_KEY!)
  const account = privateKeyToAccount(process.env.PRIVATE_KEY! as `0x${string}`)

  // Buscar 3 coins para análise
  const exploreResp = await getCoinsMostValuable({ chainIds: [base.id], count: 3 })
  const coins = exploreResp.data?.exploreList?.edges ?? []

  console.log('Analisando estrutura das calls...\n')

  for (const edge of coins) {
    const coin = edge.node

    const tradeParams: TradeParameters = {
      sell: { type: 'eth' },
      buy: { type: 'erc20', address: coin.address as Address },
      amountIn: parseEther('0.0001'),
      slippage: 0.03,
      sender: account.address,
    }

    const resp = await createTradeCall(tradeParams)

    console.log(`=== ${coin.name} ===`)
    console.log(`Target: ${resp.call.target}`)
    console.log(`Value: ${resp.call.value}`)
    console.log(`Data (primeiros 10 bytes): ${resp.call.data.slice(0, 22)}`)
    console.log(`Data length: ${resp.call.data.length}`)

    // Verificar se tem trade info
    if (resp.trade) {
      console.log(`Trade commands: ${resp.trade.commands.length}`)
      console.log(`Trade inputs: ${resp.trade.inputs.length}`)
    }
    console.log('')
  }

  // Verificar se todos vão para o mesmo target
  const targets = new Set<string>()
  for (const edge of coins) {
    const resp = await createTradeCall({
      sell: { type: 'eth' },
      buy: { type: 'erc20', address: edge.node.address as Address },
      amountIn: parseEther('0.0001'),
      slippage: 0.03,
      sender: account.address,
    })
    targets.add(resp.call.target)
  }

  console.log(`\nTargets únicos: ${targets.size}`)
  console.log([...targets].join('\n'))
}

main().catch(console.error)
