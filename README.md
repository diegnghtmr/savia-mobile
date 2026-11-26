# Savia Mobile

Savia Mobile is the Expo app for Savia, a personal finance system. Sign in with Supabase Auth to use the Savia API from Android or iOS.

## Features

- View accounts and balances, record transactions and transfers, and work with budgets, funds, and debts. Review detected subscription candidates and confirm or dismiss them.
- Import CSV statements, create exports and download the results, and upload receipt images to review before confirming an expense.
- Read the notification inbox and change notification preferences. The app only attempts push registration when you tap **Register this device** (`Registrar este dispositivo`) in Notification Settings. Push registration needs a non-development Android or iOS build with an Expo project ID and notification permission.
- Reopen supported data you've already loaded when offline. The on-device cache uses SQLCipher, with its database key stored in Expo Secure Store.
- Review and decide pending assistant proposals, and view active sessions or close other sessions.
- Choose which dashboard cards appear and in what order, set the reporting period and display currency, and explore spending, cash flow, and advanced analytics.

## Repositories

- [savia-web](https://github.com/diegnghtmr/savia-web) — web app and account setup.
- [savia-backend](https://github.com/diegnghtmr/savia-backend) — HTTP API and background worker.
- [savia-mcp](https://github.com/diegnghtmr/savia-mcp) — local MCP protocol server.
- [savia-cli](https://github.com/diegnghtmr/savia-cli) — command-line client for Savia.

## Stack

- Node.js 24.18.0, pnpm 11.15.1, and TypeScript 6.0.3
- Expo 57.0.8 and Expo Router 57.0.8
- React Native 0.86.0 and React 19.2.3
- Jest 29.7.0 and React Native Testing Library 14.0.1

## Run locally

Use the tool versions pinned in `mise.toml`. You need a Supabase Auth project and a running Savia API reachable from the device or emulator. Set these public variables before starting Expo:

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | HTTPS origin of the Supabase project. |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable key or legacy `anon` key. Never use a service-role key. |
| `EXPO_PUBLIC_SAVIA_API_URL` | Savia API origin, without a path. Use HTTPS; development builds also accept HTTP on loopback. |

If Supabase email confirmation is enabled for sign-up, allow `co.savia.mobile://auth/callback` as a redirect URL.

Use a native build rather than Expo Go so the app includes the SQLCipher configuration. With the Android or iOS build tools installed, run:

```sh
pnpm install --frozen-lockfile
pnpm exec expo run:android # or: pnpm exec expo run:ios on macOS
```

## Tests

```sh
pnpm test
pnpm typecheck
pnpm run audit
pnpm audit:test
```

`pnpm run audit` runs the repository boundary audit; plain `pnpm audit` is pnpm's dependency vulnerability check. `pnpm audit:test` exercises the repository audit rules.

## Repository structure

| Path | Purpose |
| --- | --- |
| `src/app/` | Expo Router entry points, screen wiring, and sign-up callback |
| `src/foundation/` | Authentication, API clients, and encrypted offline storage |
| `src/mobile-shell/` | Screens and device integrations |
| `__tests__/` | Jest tests |
| `scripts/` | Repository audit and its tests |

## License

MIT, see [LICENSE](LICENSE).
