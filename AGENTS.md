# Repository instructions

## Release notes

Release history is maintained in GitHub Releases, not in a local changelog. The publish workflow automatically generates notes for the changes since the previous published stable release, including commits, changed-file statistics, and a comparison link. Do not recreate `CHANGELOG.md` or bump versions manually; release automation owns version updates.

## 重大功能与 README 同步

- Bridge 项目每次新增重大功能（包括独立页面、管理入口或重要用户能力），都必须在同一批代码变更中同步更新 `README.md` 和 `README.en.md`，不能只更新代码、设计文档或发布说明。
- README 应更新相应的功能概览和使用说明，说明入口、操作方式、影响范围及必要的版本或配置要求；涉及界面变化时，同步维护相关截图与说明，确保与最终实现一致。
- 提交或 push 前必须核对：新增功能是否已在两份 README 中准确体现。README 未同步时，不得将该功能视为交付完成。
- 此规则不要求手动提升版本号；版本更新继续由发布自动化负责。
