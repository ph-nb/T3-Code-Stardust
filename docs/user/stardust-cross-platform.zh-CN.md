# Stardust 跨平台 UI 与本地构建

本次移植基于 `ph-nb/T3-Code-Stardust` 的 `62196999e6`（Stardust v1.2.3）。Windows、Linux 桌面客户端与 macOS 共用 React 界面和 Electron 外壳；Android 使用原生 React Native 客户端。

## 界面范围

| 平台            | 适配内容                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows / Linux | 默认 Stardust 浅色和深色主题，Composer V9、V18 星舰推理滑块、会话与缓存统计、额度面板、任务步骤卡、产物面板等现有共享 Web UI；系统字体回退、Stardust 应用名和图标、平台与架构对应的更新提醒。 |
| Android         | Stardust 应用名与图标、原生浅色和深色主题、模型胶囊和输入台阴影、模型设置中的星舰推理滑块、用量限额圆环、会话概览和令牌缓存底部统计面板。保留原生导航、输入框和现有移动端功能。               |

星舰场景源码位于 `packages/shared/src/starshipScene.ts`，桌面和 Android 的本地 Canvas 使用同一绘制器。Android 在触摸结束时提交模型支持的推理选项，支持无障碍增减操作和系统减少动态效果；空闲两秒停止绘制，进入后台停止动画。

首次使用默认选择 Stardust 主题并跟随系统明暗。已有主题选择继续生效，可以在外观设置中切换到 Stardust（桌面主题列表名为“苹果”）。

会话概览与令牌缓存共用 packages/client-runtime/src/sessionStats.ts 的统计逻辑；Android 用原生底部表单展示轮次、步骤、模型与工具耗时、输出速率、令牌数量和缓存命中率，新增文案覆盖全部十种语言。

macOS 的磁盘清理依赖本机系统能力，其执行后端仍仅支持 macOS。Android 的布局按触屏和原生导航适配；Electron 内嵌浏览器窗口及其批注界面仍属于桌面功能。

## 开发工具

- Node.js `26.13.1`、pnpm `12.14.0`，安装 Vite+ 后在仓库根目录执行 `vp install --frozen-lockfile`。
- Windows 安装 Rust MSVC 工具链和 Visual Studio C++ Build Tools。
- Linux 安装 Rust，以及 `build-essential libsecret-1-dev pkg-config imagemagick`；AppImage 运行环境需要 FUSE。
- Android 安装 JDK 17 和 Android SDK，并配置 `JAVA_HOME`、`ANDROID_HOME`。最低 Android API 为 24，具体编译 SDK 由 Expo 58 生成的工程决定。

## 本地构建

在对应系统的仓库根目录执行：

```text
vp run dist:stardust:windows
vp run dist:stardust:linux
vp run dist:stardust:android
```

Windows、Linux 默认构建 x64；ARM64 桌面构建可使用：

```text
vp run dist:desktop:artifact --platform win --target nsis --arch arm64 --build-version 1.2.3
vp run dist:desktop:artifact --platform linux --target AppImage --arch arm64 --build-version 1.2.3
```

Linux 的 Debian 安装包可将 `--target AppImage` 改为 `--target deb`。构建产物输出到根目录 `release/`，例如 `Stardust-1.2.3-win-x64.exe`、`Stardust-1.2.3-linux-x64.AppImage`、`Stardust-1.2.3-android.apk`。配置更新 feed 的 AppImage 使用无版本号文件名，以兼容原位更新。

Android 脚本先生成主题与原生工程，再执行 Gradle `assembleRelease`。默认原生模板使用开发签名，适合本地安装验证；正式分发需要配置自己的 Android 签名。Windows 的 WSL 后端可通过现有 `--wsl-runtime` 参数额外嵌入对应架构的 Linux CLI 压缩包。

Windows 图标可用以下命令从现有 Stardust PNG 重新生成：

```text
vp run icons:stardust
```

## GitHub Actions

`Stardust cross-platform builds` 支持手动触发，也会在 `codex/stardust-cross-platform-ui` 分支推送代码时运行，提供 Windows x64 / ARM64、Linux x64 / ARM64 和 Android APK 五个目标。仅修改 Markdown 文档不会触发构建。结果保存为当前运行的 Actions artifacts；工作流不会创建或发布 Release。

工作流需先推送到自己的 GitHub 仓库，才能在 Actions 中运行。桌面更新 feed 指向 `ph-nb/T3-Code-Stardust`；本地构建可以通过 `T3CODE_DESKTOP_UPDATE_REPOSITORY` 配置。社区更新提醒仅认可当前系统和架构、文件已上传且具有 SHA256 摘要的安装包。

Android OTA 默认关闭。启用时必须同时设置 `T3CODE_MOBILE_UPDATES_ENABLED=1` 和自己的 `T3CODE_MOBILE_UPDATE_URL`，避免远端更新覆盖移植后的界面。本地 APK 构建脚本保持 OTA 关闭。

## 已验证与待验证

本次在 Windows 主机完成了 Web 生产构建、Electron 与服务端 JS bundle 构建、Android Hermes bundle 和资源导出，以及 Android 原生工程生成；桌面、Web、移动端、shared、contracts、client-runtime 六个包的类型检查通过。推理滑块既有浏览器测试、更新解析、移动主题、本地消息桥接及会话统计有定向测试覆盖。

当前主机未配置完整的 Rust/MSVC、JDK 和 Android SDK 构建工具链，尚未生成可安装的 EXE、AppImage 或 APK，也未完成三个平台的安装和真机运行验证。客户端验证所需的仓库 Browser / Device 工具在本会话不可用。

额外检查发现仓库原有问题：`scripts/build-desktop-artifact.test.ts` 对 macOS preview 的 `untrusted_bundle` 断言失败（相应工作流缺少该配置），Knip 报告 18 个原有未使用文件，`scripts` 包的类型检查因迁移脚本跨项目导入、已有配置读取等错误而失败。本次未修复这些独立问题，也未宣称仓库全量检查通过。
