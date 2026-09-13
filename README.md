# Bilibili Userscripts

个人 Bilibili 用户脚本同步仓库。仓库中的脚本使用稳定的 `.user.js` 地址，适合在 Tampermonkey 中安装和更新。

## 安装

在安装了 Tampermonkey 的设备上打开下面的 Raw 地址即可安装：

- [哔哩发评反诈 Pro](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-anti-fraud-pro.user.js)
- [B站评论楼层导出器](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-comment-thread-exporter.user.js)
- [B站直播自动最高/最低画质](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/bilibili-live-auto-quality.user.js)
- [Make BiliBili Great Again ProMax](https://raw.githubusercontent.com/yunnre060214-sudo/bilibili-userscripts/main/make-bilibili-great-again-promax.user.js)

## 更新

以后直接编辑对应的 `.user.js` 文件并提交到 `main` 分支即可。每次修改代码时必须同步递增文件头部的 `@version`，Tampermonkey 才会识别为新版本；在油猴设置中点击“检查更新”即可拉取更新。
