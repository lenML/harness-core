# harness-core

harness core

## 特点

- 微内核：最小核心驱动方便拓展
- 可中断：基于所有操作均可中断假设开发
- code as document：代码即文档，所有接口文档均以 typescript 代码提供 见 [./docs](./docs)
- markdown as skill：降级 skill 定义，所有 markdown 都被视为 skill 且无特殊格式要求

## usage

```
npx tsx ./src/main.ts
```
