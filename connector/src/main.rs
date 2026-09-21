use cybercore_agent::{Connector, ConnectorError};
use std::{env, path::PathBuf, process::ExitCode};

fn usage() {
    eprintln!("usage: cybercore-agent --config <path> [once|run]");
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let mut config = None;
    let mut mode = "once";
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => config = args.next().map(PathBuf::from),
            "once" | "run" => mode = Box::leak(arg.into_boxed_str()),
            "--help" | "-h" => {
                usage();
                return ExitCode::SUCCESS;
            }
            _ => {
                usage();
                return ExitCode::from(2);
            }
        }
    }
    let Some(path) = config else {
        usage();
        return ExitCode::from(2);
    };
    match cybercore_agent::Config::from_file(&path).and_then(Connector::new) {
        Ok(connector) if mode == "once" => match connector.send_once() {
            Ok(result) => {
                println!(
                    "heartbeat accepted attempts={} observed_at={}",
                    result.attempts, result.observed_at
                );
                ExitCode::SUCCESS
            }
            Err(error) => report(error),
        },
        Ok(connector) => match connector.run_periodic(|result| {
            println!(
                "heartbeat accepted attempts={} observed_at={}",
                result.attempts, result.observed_at
            )
        }) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => report(error),
        },
        Err(error) => report(error),
    }
}

fn report(error: ConnectorError) -> ExitCode {
    eprintln!("cybercore-agent: {error}");
    ExitCode::from(1)
}
