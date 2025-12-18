# Zora Batch Buy

Batch buy multiple Zora coins in a single atomic transaction using Multicall3.

## Features

- Buy up to 10 Zora coins in one transaction
- Atomic execution (all or nothing)
- Automatic fetching of top coins by market cap
- Uses Multicall3 for gas efficiency

## Requirements

- Node.js 18+
- pnpm

## Setup

```bash
pnpm install
cp .env.example .env
```

Edit `.env` with your credentials:

```
RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0x...
ZORA_API_KEY=your_zora_api_key
```

## Usage

```bash
pnpm start
```

This will:
1. Fetch top 10 coins by market cap from Zora
2. Get quotes for each coin
3. Execute all swaps in a single transaction via Multicall3

## Configuration

Edit `batchBuyMulticall.ts` to change:

- `ETH_PER_COIN` - Amount of ETH to spend per coin (default: 0.0001)
- `SLIPPAGE` - Slippage tolerance (default: 0.03 = 3%)
- `NUM_COINS` - Number of coins to buy (default: 10)

## Scripts

- `pnpm start` - Run batch buy with Multicall3 (recommended)
- `pnpm start:single` - Run individual transactions per coin
- `pnpm build` - Compile TypeScript

## How It Works

1. Fetches top coins using Zora SDK `getCoinsMostValuable`
2. Gets swap calldata for each coin using `createTradeCall`
3. Bundles all calls into Multicall3 `aggregate3Value`
4. Sends single transaction with total ETH value

## License

ISC
