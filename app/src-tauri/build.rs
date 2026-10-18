fn main() {
    let _ = std::fs::create_dir_all("../out/renderer");
    tauri_build::build()
}
