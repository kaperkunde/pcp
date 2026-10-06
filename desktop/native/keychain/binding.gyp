# The Touch ID keychain module (keychain.m), built by scripts/keychain.mjs
# on macOS only. Node-API is ABI-stable, so a build against this Node's
# headers loads in Electron too: no Electron headers, no rebuild per version.
{
  "targets": [
    {
      "target_name": "pcp_keychain",
      "conditions": [
        [
          "OS=='mac'",
          {
            "sources": ["keychain.m"],
            "xcode_settings": {
              "CLANG_ENABLE_OBJC_ARC": "YES",
              "MACOSX_DEPLOYMENT_TARGET": "12.0",
              "WARNING_CFLAGS": ["-Wall", "-Wextra", "-Wno-unused-parameter"]
            },
            "link_settings": {
              "libraries": [
                "-framework Foundation",
                "-framework Security",
                "-framework LocalAuthentication"
              ]
            }
          }
        ]
      ]
    }
  ]
}
