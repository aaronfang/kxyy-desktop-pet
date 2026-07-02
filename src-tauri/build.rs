fn main() {
    let enc = std::path::Path::new("assets/persona-assets.enc");
    if !enc.exists() {
        panic!(
            "缺少 assets/persona-assets.enc，请先运行: npm run encrypt-assets"
        );
    }
    println!("cargo:rerun-if-changed=assets/persona-assets.enc");
    tauri_build::build();
}
