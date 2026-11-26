# Savia Mobile

Savia Mobile is the Expo shell for Savia, a personal finance app in development. Its home screen shows an empty state and a disabled action for recording a movement. It does not sign users in, load financial records, or connect to the API.

## Repositories

- [savia-web](https://github.com/diegnghtmr/savia-web) — web app and account setup.
- [savia-backend](https://github.com/diegnghtmr/savia-backend) — HTTP API and background worker.
- [savia-mcp](https://github.com/diegnghtmr/savia-mcp) — local MCP protocol server.

## Stack

- Node.js 24.18.0, pnpm 11.15.1, and TypeScript 6.0.3
- Expo 57.0.8 and Expo Router 57.0.8
- React Native 0.86.0 and React 19.2.3
- Jest 29.7.0 and React Native Testing Library 14.0.1

## Run locally

Use the tool versions in `mise.toml`. Start the Expo development server and open the app on a compatible device or emulator. The shell does not need a backend or an account.

```sh
pnpm install --frozen-lockfile
pnpm exec expo start
```

## Tests

```sh
pnpm test
pnpm typecheck
pnpm run audit
pnpm audit:test
```

The Jest suite covers the shell. The audit checks the file inventory and source boundary; its fixtures verify that unauthorized paths and networked source are rejected.

## Repository structure

| Path | Purpose |
| --- | --- |
| `src/app/` | Expo Router layout, home screen, and not-found screen |
| `src/mobile-shell/` | Color palettes for the shell |
| `__tests__/` | Shell component tests |
| `scripts/` | Repository audit and its tests |

## License

MIT, see [LICENSE](LICENSE).
