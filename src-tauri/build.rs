fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "vault_list",
                "vault_put",
                "vault_reveal",
                "vault_delete",
            ]),
        ),
    )
    .expect("tauri build")
}
