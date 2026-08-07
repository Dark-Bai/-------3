"""
thsdk.examples 模块

此模块包含 thsdk 的示例代码，展示了如何使用行情 API 的不同功能。
示例覆盖国内固定长度行情接口、通用市场查询接口、板块与列表接口、以及杂项工具接口。
示例统一推荐使用 `with THS() as ths:`，并遵循“失败后立即 return/continue，再访问 response.df”的错误处理规则。

账户配置说明：
    - 推荐方式：使用您自己的账户
      ths = THS({"username": "your_username", "password": "your_password","mac": "your_mac_address"})
    
    - 测试方式：使用 demo 账户（会自动切换为临时游客账户）
      ths = THS({"username": "your_username", "password": "your_password","mac": "your_mac_address"})
    
    ⚠️ 重要提示：临时游客账户仅供测试，可能随时失效，不适合生产环境。

连接管理方式：

方式一：使用上下文管理器（推荐，自动管理连接）
    with THS({"username": "your_username", "password": "your_password","mac": "your_mac_address"}) as ths:
        # 自动连接和断开
        response = ths.klines("USZA300033", count=100)

方式二：手动管理连接生命周期
    ths = THS({"username": "your_username", "password": "your_password","mac": "your_mac_address"})
    ths.connect()
    try:
        response = ths.klines("USZA300033", count=100)
    finally:
        ths.disconnect()  # 重要：确保断开连接

注意：系统使用 TCP 连接，异常后务必调用 disconnect() 断开连接。

批量检查与执行：
    - 语法检查：python thsdk/examples/run_all_examples.py
    - 顺序执行：python thsdk/examples/run_all_examples.py --mode live
    - API冒烟测试：python thsdk/examples/test_thsdk.py --suite all
"""
