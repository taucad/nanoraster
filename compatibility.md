# Compatibility

| Host        | Supported | CI evidence                             |
| ----------- | --------- | --------------------------------------- |
| Node 24.0.0 | ✅        | `node (24.0.0)`                         |
| Node 26     | ✅        | `node (26)`                             |
| Chromium    | ✅        | `browser (chromium)`                    |
| Firefox     | ✅        | `browser (firefox)`                     |
| WebKit      | ✅        | `browser (webkit)`                      |
| Linux x64   | ✅        | `native (ubuntu-24.04, linux-x64-gnu)`  |
| macOS arm64 | ✅        | `native (macos-14, darwin-arm64)`       |
| Windows x64 | ✅        | `native (windows-2022, win32-x64-msvc)` |

## Render profile

| glTF 2.0 feature                                       | Supported |
| ------------------------------------------------------ | --------- |
| `baseColorFactor`, `metallicFactor`, `roughnessFactor` | Yes       |
| Embedded PBR textures and texture coordinates          | No        |
| Surface-less WebGPU rendering                          | Yes       |

Factor-only metallic-roughness materials use deterministic analytic studio
lighting. Texture-backed materials return a parse error.
