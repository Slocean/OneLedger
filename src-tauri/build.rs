fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "vault_list",
                "vault_put",
                "vault_organize",
                "vault_reveal",
                "vault_delete",
                "key_reveal",
            ]),
        ),
    )
    .expect("tauri build")
}
