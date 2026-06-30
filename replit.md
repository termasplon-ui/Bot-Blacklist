# Family Discord Bot

Discord-бот для управления чёрным списком и предупреждениями в семье (GTA RP / игровое сообщество).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — запустить API сервер + Discord бот (порт 5000)
- `pnpm run typecheck` — полная проверка типов по всем пакетам
- `pnpm --filter @workspace/db run push` — применить изменения схемы БД (только dev)
- Required env: `DATABASE_URL`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Bot: discord.js v14
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/bot/client.ts` — весь код Discord-бота
- `lib/db/src/schema/blacklist.ts` — таблица ЧС
- `lib/db/src/schema/warnings.ts` — таблица предупреждений

## Bot features

- `/panel` — отправляет сообщение с 3 кнопками (только для роли с ManageGuild/Administrator)
- **⛔ Выдать ЧС** — модал: никнейм, причина, дни (0=навсегда), амнистия, от кого
- **⚠️ Предупреждение** — модал: никнейм, причина, от кого; снимается через 7 дней; при 3/3 автоматический ЧС
- **📋 История** — показывает последние 5 ЧС + 5 предупреждений по нику (ephemeral)
- Авто-истечение: каждые 10 минут снимает истёкшие предупреждения и ЧС

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- `discord.js` externalized в esbuild (не бандлится) — должен быть в node_modules рядом с dist/
- Перед регистрацией команд проверь что DISCORD_CLIENT_ID — числовой Application ID, не токен
- Предупреждения и авто-ЧС выполняются в одной DB-транзакции (race-safe)
