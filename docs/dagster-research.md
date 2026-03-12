# Dagster Research: Lessons for Zyra Editor

## Architecture Comparison

| Aspect | Dagster | Zyra Editor |
|--------|---------|-------------|
| Pipeline definition | Python decorators + code-first | Visual graph → YAML export |
| DAG execution | Topological sort with executors, retries, partial re-execution | Topological sort → linear pipeline.yaml |
| Type system | Runtime `DagsterType` with type-check functions on every port | `portsCompatible()` checking type strings |
| UI ↔ Backend | GraphQL API (complete decoupling) | REST + WebSocket (tighter coupling) |
| State/storage | Pluggable storage backends (SQLite, Postgres) | Stateless — no run history |
| Monorepo | ~50 Python packages + JS workspace | 2 TS packages + 1 Python server |

## Dagster Core Concepts

### Primary Abstractions

- **Software-Defined Assets (SDAs)** — The modern primary abstraction. An asset represents a logical data object (table, file, ML model) defined in code. You declare what the asset is, its upstream dependencies, and a function to compute its contents. Assets form a DAG through their declared dependencies.
- **Ops** — Lower-level unit of computation: Python functions decorated with `@op` containing transformation logic with typed inputs and outputs. Largely superseded by assets in modern Dagster.
- **Graphs** — Connect multiple ops into a DAG using `@graph`, defining topology without execution details.
- **Jobs** — Primary execution unit: either a selection of assets or a graph of ops bound to specific configuration. Triggered manually, by schedules, or by sensors.
- **Definitions** — Top-level container combining all Dagster entities into a single deployable unit.
- **Code Locations** — Isolated Python environments hosting a `Definitions` object, enabling dependency isolation across teams.

### Automation

- **Schedules** — Trigger jobs at cron-like intervals.
- **Sensors** — Trigger jobs in response to external events (new file, webhook, database change).
- **Declarative Automation** — Declare conditions under which assets should be materialized; the system determines when to run.

### Data Management

- **Resources** — Dependency-injected external services (databases, APIs, file systems). Declared once, injected into assets/ops by parameter name.
- **IO Managers** — Define how data is stored and retrieved between asset/op executions. Abstract the serialization layer so the same asset code can write to local disk in dev and S3 in production.
- **Partitions** — Logical data slices (e.g., daily time windows, geographic regions) enabling incremental processing.

## Dagster UI (formerly Dagit)

The UI is a React/TypeScript web application communicating with the backend exclusively through a GraphQL API.

### Key UI Features

- **Asset Graph / Lineage View** — Interactive DAG visualization with filtering by asset key, compute kind, groups, code locations, and tags.
- **Run Monitoring** — Lists all executions with Gantt charts showing per-step timing, error information, and structured event logs.
- **Log Viewing** — Structured event logs with metadata enrichment and filtering by log level/step/event type, plus raw compute logs (stdout/stderr) with download.
- **Launchpad** — Configuration editor for launching jobs with YAML/JSON config and schema validation.
- **Asset Details** — Overview, partitions view, materialization events, asset checks, lineage, and automation conditions.
- **Schedules & Sensors** — Dedicated pages with upcoming tick previews and historical execution data.

## Dagster Type System & Port Compatibility

- **DagsterType** — Core class with type-check functions that validate runtime values.
- **Input type checks** run before op execution; **output type checks** run after.
- Built-in types: `Nothing`, `String`, `Int`, `Float`, `Bool`, plus container types.
- Custom types via `DagsterType` class, `PythonObjectDagsterType` (isinstance-based), or `@usable_as_dagster_type` decorator.
- Between ops in a graph, Dagster validates output type → input type compatibility. The `Nothing` type acts as a wildcard.

## Dagster Execution Model

1. **Run Coordinator** receives launch request, queues the run.
2. **Run Launcher** picks up queued runs and spawns worker processes/containers.
3. **Run Worker** processes the full job graph.
4. **Executor** steps through ops (in-process, multiprocess, Celery, K8s, Docker).

### Retry Mechanisms

- **Run-level**: `FROM_FAILURE` (skip successful ops, re-run from first failure) or `ALL_STEPS` (re-execute everything).
- **Op-level**: `RetryPolicy` (declarative max retries, delay, backoff) or `RetryRequested` exception (programmatic).

### Partial Re-execution

Users can re-execute a subset of steps from a previous run. The system loads outputs from the parent run's successful steps via the IO manager.

## Dagster Monorepo Structure

| Directory | Purpose |
|-----------|---------|
| `python_modules/dagster/` | Core framework: definitions, execution, storage, types, config, CLI, daemon, gRPC |
| `python_modules/dagster-graphql/` | GraphQL API layer |
| `python_modules/dagster-webserver/` | HTTP server serving UI and GraphQL |
| `python_modules/dagster-pipes/` | Lightweight protocol for external process communication (zero dependencies) |
| `python_modules/libraries/` | 40+ integration packages (aws, gcp, dbt, snowflake, etc.) |
| `js_modules/ui-core/` | Main UI application (React, TypeScript, Apollo/GraphQL) |
| `js_modules/ui-components/` | Shared component library |
| `js_modules/app-oss/` | OSS application shell |

### Key Architectural Boundaries

1. Core `dagster` package has zero web dependencies — pure orchestration engine.
2. `dagster-graphql` provides the API layer.
3. `dagster-webserver` serves the UI.
4. UI communicates only via GraphQL — complete decoupling from Python.
5. Integration libraries depend on core but are independently versioned.
6. `dagster-pipes` is intentionally minimal so it can be installed in external processes.

---

## High-Value Lessons for Zyra

### 1. Partial Re-execution / Run from Failure

Dagster lets users re-run only the failed steps of a pipeline, loading cached outputs from successful steps. Zyra currently re-runs everything. Adding node-level caching + selective re-execution would be a major UX win for long pipelines.

### 2. Structured Event Logging with Metadata

Dagster's logs are typed events (step started, output produced, failure) with attached metadata. Zyra's `LogPanel` shows raw stdout/stderr. Enriching logs with structured events (timing, input/output file paths, exit codes as metadata) would make debugging much easier.

### 3. Run History & Gantt Charts

Dagster persists every run with per-step timing, displayed as Gantt charts. Zyra has no run history. Even a lightweight SQLite-backed run log with timing per node would add significant value for pipeline optimization.

### 4. Resource / IO Manager Pattern (Dependency Injection)

Dagster's resource system cleanly separates business logic from infrastructure. Zyra could benefit from letting nodes declare abstract "resources" (e.g., `database`, `s3-bucket`) that get resolved at runtime via configuration, rather than hardcoding paths.

### 5. Configuration Schema Validation

Dagster validates job config against a schema before execution. Zyra's `ArgPanel` could validate arguments against the manifest's `ArgDef` constraints before launching a run — catching errors early in the UI.

### 6. GraphQL API Layer

Dagster's complete decoupling of UI from backend via GraphQL enables multiple clients (UI, CLI, SDK) against the same API. A typed API schema (GraphQL or OpenAPI) would improve Zyra's maintainability as the API surface grows.

## Should We Use Dagster Code Directly?

**No — but learn from their patterns.** Reasons:

- **Different paradigm**: Dagster is code-first Python; Zyra is visual-first with a CLI backend. Importing Dagster code would mean adopting their entire Python execution engine, which conflicts with Zyra's design of wrapping an existing CLI.
- **Massive dependency**: Dagster core alone is ~200K+ lines. It would dwarf the Zyra codebase.

### Patterns Worth Borrowing

- **Type system design** — Extending `portsCompatible()` with runtime type-check functions rather than just string matching.
- **Immutable record pattern** — Using frozen data structures with `with_*` update methods for graph state.
- **Snapshot serialization** — Capturing graph structure at execution time so you can compare runs.
- **IO Manager abstraction** — Define a simple interface for how nodes read/write intermediate data.

## Recommended Next Steps (Priority Order)

| # | Feature | Effort | Impact |
|---|---------|--------|--------|
| 1 | Config validation in ArgPanel | Low | Medium |
| 2 | Structured run events from server | Low | Medium |
| 3 | Run history with SQLite | Low-Medium | Medium |
| 4 | Node-level output caching | Medium | High |
| 5 | Partial re-execution from failure | Medium | High |
| 6 | Gantt chart for run timing | Medium | Medium |
| 7 | Asset lineage / data catalog view | High | Medium |
| 8 | Schedule / sensor triggers | High | Low (for now) |
