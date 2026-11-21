# Repository Guidelines

## Project Structure & Module Organization

Workbench uses Tauri 2, React, TypeScript, Zustand, Ant Design, Tailwind CSS, and Rust.

- `src/features/<module>/`: feature views, state, IPC wrappers, and styles.
- `src/core/`: shared contracts and services; `src/shell/`: navigation and module hosting; `src/store/`: workbench state.
- `src-tauri/src/core/` and `src-tauri/src/modules/`: shared native services and feature backends.
- `scripts/`: logic tests and source checks.
- `public/` and `src-tauri/icons/`: application assets; `docs/screenshots/`: UI references; `design/`: prototypes.
- `ai-balance-utools/` and `desktop-pet-utools/`: separate CommonJS uTools plugins.

## Build, Test, and Development Commands

Prerequisites: Node.js 20+, Rust stable/Cargo, Tauri system dependencies, and macOS 12+.

- `npm ci`: install locked frontend dependencies.
- `npm run dev`: run the Vite frontend; native capabilities require Tauri.
- `npm run tauri:dev`: launch desktop development; stops an existing Workbench app.
- `npm run typecheck`: check strict TypeScript types.
- `npm run build`: typecheck and produce frontend assets.
- `npm run tauri:build`: package installers; removes generated release `.app` bundles afterward.
- `npm run test:logic`: bundle and execute Node-based logic assertions.
- `cargo test --manifest-path src-tauri/Cargo.toml`: run Rust tests.
- `npm run check:labels` / `npm run check:git-theme`: validate balance-label contracts / Git module styling.

## Coding Style & Naming Conventions

Use two-space TypeScript indentation, single quotes, and semicolons; four-space Rust indentation. No ESLint or Prettier configuration is present. Use PascalCase component files, `use*` hooks, and snake_case Rust functions.

Keep business logic inside features. Register frontend modules in `src/core/modules.ts`; register native commands in `src-tauri/src/main.rs`. Prefix commands with `<module>_`, use shared `call()` / `ApiResponse<T>`, and theme UI through `--wb-*` tokens.

## Testing Guidelines

Extend `scripts/logic-test.ts` with descriptive assertions; keep storage/Tauri stubs before business imports and namespace new module imports. Rust uses `#[cfg(test)]` modules and behavior-named `#[test]` functions. No coverage threshold is configured.

Run typechecking, relevant tests, and the frontend build before review. Run contract checks when touching their modules. Verify native integrations in the desktop app and UI changes in both themes.

## Commit & Pull Request Guidelines

Git metadata is absent here, so history conventions cannot be verified. Recommended: scoped imperative subjects such as `fix(git): preserve branch selection`. Keep commits focused. PRs should explain behavior changes, link relevant issues, list checks and manual verification, and include screenshots for UI changes.

## Security & Configuration

Keep credentials out of source, logs, and screenshots. Reuse shared master-key, encryption, and namespaced storage services. Exclude generated `dist/`, `node_modules/`, and `src-tauri/target/` artifacts from commits.
