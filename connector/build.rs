use std::env;

fn main() {
    let commit = env::var("CYBERCORE_GIT_SHA").unwrap_or_else(|_| "unknown".to_owned());
    let target = env::var("TARGET").unwrap_or_else(|_| "unknown".to_owned());
    println!("cargo:rustc-env=CYBERCORE_GIT_SHA={commit}");
    println!("cargo:rustc-env=CYBERCORE_TARGET={target}");
}
