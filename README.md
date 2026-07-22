# Arbitr — DEX-DEX Arbitrage Bot

Автоматический арбитражный бот для Base / Arbitrum / Monad.

## Стратегия

2-hop DEX-DEX арбитраж: купить токен на DEX A → продать на DEX B.
Поддержка двух режимов исполнения:
- **direct** — прямой капитал (2 свапа подряд)
- **flashloan** — flash loan через Aave V3 (нулевой капитал)

## Быстрый старт

```bash
npm install
cp .env.example .env   # заполнить RPC + PRIVATE_KEY
npm run dev            # monitor-only mode (без ключа)
npm start              # production mode
```

## Структура

```
src/
├── index.ts              — главный цикл (poll → detect → execute)
├── config.ts             — конфиги цепей, DEX, токенов
├── types.ts              — общие типы
├── providers.ts          — viem clients (HTTP/WS)
├── logger.ts             — логгер
├── executor.ts           — direct capital исполнение
├── dex/
│   └── quoter.ts         — котировки V2/V3 через multicall
├── strategy/
│   ├── arbitrage.ts      — детект 2-hop арбитража
│   └── arbitrage.test.ts — юнит-тесты
└── execution/
    └── flashloan.ts      — flash loan исполнение (Aave V3)

contracts/
└── FlashArb.sol          — Solidity контракт для flash loan арбитража
```

## Конфигурация (.env)

| Переменная | Описание |
|---|---|
| `BASE_RPC_WSS` | WebSocket RPC для Base |
| `BASE_RPC_HTTPS` | HTTP RPC для Base |
| `PRIVATE_KEY` | Приватный ключ кошелька |
| `MIN_PROFIT_USD` | Минимальный профит для исполнения |
| `MAX_GAS_GWEI` | Максимальная цена газа |
| `POLL_INTERVAL_MS` | Интервал опроса (мс) |
| `EXECUTION_MODE` | `direct` или `flashloan` |
| `TRADE_AMOUNT_ETH` | Размер сделки (ETH) |
| `ACTIVE_CHAIN` | `base` / `arbitrum` |

## Тесты

```bash
npm test
```

## Деплой FlashArb (для режима flashloan)

1. Установить Foundry: `curl -L https://foundry.paradigm.xyz | bash`
2. Скомпилировать: `forge build`
3. Задеплоить: `forge create contracts/FlashArb.sol:FlashArb --constructor-args <AAVE_POOL> --rpc-url <RPC> --private-key <KEY>`
4. Вписать адрес в `src/execution/flashloan.ts` → `FLASH_ARB_ADDRESS`

## Roadmap

- [x] Scaffold + конфиг
- [x] V2/V3 котировки
- [x] 2-hop стратегия
- [x] Direct execution
- [x] Flash loan контракт
- [ ] Multicall3 батчинг (оптимизация RPC)
- [ ] Mempool monitoring (pending tx)
- [ ] 3-hop + triangular арбитраж
- [ ] Monad интеграция
- [ ] Flashbots / private tx pool
- [ ] Dashboard / Telegram алерты
