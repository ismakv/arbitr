# Arbitr — Multi-Protocol Liquidation Bot

Автоматический ликвидационный бот для Aave V3, Morpho Blue, Compound V3 на Base + Arbitrum.

## Протоколы

| Протокол | Base | Arbitrum | Ликвидация | Бонус |
|----------|------|----------|------------|-------|
| Aave V3 | ✅ | ✅ | `liquidationCall()` | 5% |
| Morpho Blue | ✅ | ✅ | `liquidate()` | 5-10% |
| Compound V3 | ✅ | ✅ | `absorb()` | 5-8% |

## Быстрый старт

```bash
npm install
cp .env.example .env
npm run dev          # monitor-only (без ключа)
```

## Env переменные

| Переменная | Описание |
|---|---|
| `PRIVATE_KEY` | Ключ кошелька (без него = monitor-only) |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram бота |
| `TELEGRAM_CHAT_ID` | Chat ID для алертов |
| `BASE_RPC_HTTPS` | RPC для Base (default: public) |
| `ARBITRUM_RPC_HTTPS` | RPC для Arbitrum (default: public) |
| `INFURA_KEY` | Infura API key (fallback RPC) |
| `POLL_INTERVAL_MS` | Интервал опроса (default: 4000) |
| `MIN_PROFIT_USD` | Мин. профит для исполнения (default: 5) |

## Telegram алерты

- 🟢 бот запущен
- 🟡 позиция на грани (HF < 1.1)
- 🔴 можно ликвидировать (HF < 1.0)
- 🎉 ликвидация исполнена
- ⚪ бот остановлен

## Деплой

```bash
# Docker
docker build -t arbitr-liq-bot .
docker run -d --name arbitr-liq-bot --restart unless-stopped \
  -e TELEGRAM_BOT_TOKEN=... \
  -e TELEGRAM_CHAT_ID=... \
  arbitr-liq-bot

# Coolify (github.com/ismakv/arbitr)
# Server: 93.183.93.3
```

## Структура

```
src/
├── liquidator.ts         — оркестратор (multi-protocol, multi-chain)
├── notify.ts             — Telegram уведомления
├── protocols/
│   ├── types.ts          — общие типы
│   ├── aave.ts           — Aave V3 (Base + Arbitrum)
│   ├── morpho.ts         — Morpho Blue (Base + Arbitrum)
│   └── compound.ts       — Compound V3 (Base + Arbitrum)
├── utils/
│   ├── rpc.ts            — fallback RPC, rate limiting
│   └── gas.ts            — gas estimation, profitability check
├── dex/                  — DEX quoter (арбитраж, не используется в liq mode)
├── strategy/             — 2-hop арбитраж стратегия
├── mempool/              — mempool monitor (требует WSS)
└── execution/            — flash loan исполнение
```

## Как работает

1. Каждые 4 сек сканирует ВСЕ протоколы параллельно (Promise.all)
2. Для каждого: находит заёмщиков через event logs → проверяет Health Factor
3. При HF < 1.0: шлёт Telegram алерт + (если есть ключ) исполняет ликвидацию
4. Перед исполнением: проверяет gas cost < profit
5. Rate limiting: не более 5 req/s на RPC endpoint
6. Fallback RPC: если Infura упала → drpc.org → 1rpc.io → public

## Тесты

```bash
npm test   # vitest (стратегия арбитража)
```
