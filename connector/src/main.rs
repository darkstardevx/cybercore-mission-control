use cybercore_agent::{version_line, Connector, ConnectorError};
use std::{
    env,
    path::PathBuf,
    process::ExitCode,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

fn usage() {
    println!("cybercore-agent — outbound Cybercore Mission Control heartbeat connector");
    println!();
    println!("usage: cybercore-agent --config <path> [once|run]");
    println!();
    println!("commands:");
    println!("  once       publish one heartbeat (default)");
    println!("  run        publish periodically until interrupted");
    println!();
    println!("options:");
    println!("  --config <path>  read explicit JSON configuration");
    println!("  --version        print version and build provenance");
    println!("  --help           print this help");
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let mut config = None;
    let mut mode = "once";
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => config = args.next().map(PathBuf::from),
            "once" => mode = "once",
            "run" => mode = "run",
            "--version" | "-V" => {
                println!("{}", version_line());
                return ExitCode::SUCCESS;
            }
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
        Ok(connector) => {
            let stop = Arc::new(AtomicBool::new(false));
            let signal_stop = Arc::clone(&stop);
            if let Err(error) =
                ctrlc::set_handler(move || signal_stop.store(true, Ordering::Relaxed))
            {
                return report(ConnectorError::Configuration(format!(
                    "cannot install signal handler: {error}"
                )));
            }
            match connector.run_periodic_until(
                |result| {
                    println!(
                        "heartbeat accepted attempts={} observed_at={}",
                        result.attempts, result.observed_at
                    )
                },
                || stop.load(Ordering::Relaxed),
            ) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => report(error),
            }
        }
        Err(error) => report(error),
    }
}

fn report(error: ConnectorError) -> ExitCode {
    eprintln!("cybercore-agent: {error}");
    ExitCode::from(1)
}
