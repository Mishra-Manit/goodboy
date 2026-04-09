# Implementation Plan

## Context
- The backend API lives under `backend/coliseum/api/`, with the main FastAPI app defined in `backend/coliseum/api/server.py`.
- The server module builds two app instances:
  - `app` for API-only mode
  - `daemon_app` for daemon + API mode
- Both app instances share `_initialize_app_state(...)`, which already stores:
  - `app.state.started_at`
  - `app.state.started_at_monotonic`
- `backend/coliseum/api/server.py` already contains a health endpoint at both `GET /health` and `GET /api/health`.
- That endpoint currently calls `_build_health_response(request)`, which already returns:
  - `status`
  - `service`
  - `mode`
  - `uptime_seconds`
  - `started_at` when available
- `backend/coliseum/__main__.py` starts the FastAPI server via `uvicorn` using `coliseum.api.server:app` for `python -m coliseum api` and `coliseum.api.server:daemon_app` for `python -m coliseum daemon`.
- `backend/README.md` already documents the `/health` endpoint and shows an example response that includes `uptime_seconds`.
- There does not appear to be an existing FastAPI endpoint test suite under `backend/tests/`; current tests are focused on Kalshi/integration behavior.

## Approach
- First confirm whether the task is already satisfied by the current implementation.
- If the response contract needs any adjustment, keep the change localized to `backend/coliseum/api/server.py` so both server modes continue to share the same behavior.
- Reuse the existing startup timestamps already stored in app state rather than introducing new global state or daemon-only logic.
- If any response shape changes are made, sync the public docs/example in `backend/README.md` and manually verify through the existing CLI entrypoints.

## Steps
1. Inspect `backend/coliseum/api/server.py` and verify whether the current `GET /health` and `GET /api/health` handlers already satisfy the requirement of returning server uptime.
2. If the implementation needs adjustment, update `backend/coliseum/api/server.py`:
   - keep the canonical route at `/health`
   - keep `/api/health` as the alias
   - ensure `uptime_seconds` is computed from process start using the existing monotonic timestamp in app state
   - preserve compatibility for both `app` and `daemon_app`
3. If any response fields or semantics change, update the health-check documentation and example response in `backend/README.md` so it matches the actual API output.
4. Manually verify the endpoint through the existing startup path in `backend/coliseum/__main__.py` by running the API server and checking `GET /health` returns a payload with increasing `uptime_seconds`.
5. If no code change is required because the endpoint already exists and matches the requirement, record that the task is effectively already implemented and only make documentation cleanup changes if the docs and runtime behavior differ.

## Risks
- The task may already be complete in this branch, so the main risk is making unnecessary changes to a working endpoint.
- Uptime semantics could be interpreted differently: current behavior measures API process uptime, not OS uptime or daemon cycle uptime.
- In reload/dev mode, FastAPI/uvicorn restarts will reset uptime, which is expected for process uptime but may surprise callers.
- If someone expects daemon-specific uptime in daemon mode, they may confuse `/health` with `/api/daemon/status`, which already exposes daemon diagnostics separately.
- There is no clear existing endpoint test coverage for FastAPI routes, so verification may rely on manual API checks unless a future stage adds tests.