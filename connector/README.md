# cybercore-agent

Experimental outbound-only Rust connector for Cybercore Mission Control.

## Safety boundary

This package publishes bounded heartbeat metadata. It does not listen for connections, receive
commands, execute processes, upload files, or modify AgentForge state. Cloud responses are treated
as acknowledgements only. The package is alpha software and is not release-ready.

## Configure

Copy [`example-config.json`](example-config.json) and set:

- `endpoint`: the Mission Control base URL; HTTPS is required except for loopback test fixtures;
- `agent_id`: the registered agent identifier;
- exactly one of `credential_env` or `credential_file`;
- optional bounded `payload`, `timeout_secs`, `interval_secs`, `max_retries`, and `retry_delay_ms`.

Register the agent through the admin API first. The returned `mc_...` credential is shown once.
For a file source, write it with owner-only permissions:

```sh
install -m 600 /dev/null "$HOME/.config/cybercore-agent/credential"
printf '%s\n' 'mc_replace_me' > "$HOME/.config/cybercore-agent/credential"
```

The connector refuses group/world-readable Unix credential files and never prints credentials.

## Run

```sh
cargo run --locked -p cybercore-agent -- --config connector/config.json once
cargo run --locked -p cybercore-agent -- --config connector/config.json run
```

`once` sends one heartbeat. `run` repeats at the configured interval with bounded retries and
timeouts. Stop it with the normal terminal interrupt. A non-success response is reported without
including response bodies or credentials.

## Validation

```sh
cargo fmt --check
cargo test --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
```

No production deployment or real operator credential is required for the test suite.
