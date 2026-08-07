import pandas as pd

from thsdk import THS


def _pick_code_column(df: pd.DataFrame) -> str | None:
    for column in ("代码", "THSCODE", "Code", "code"):
        if column in df.columns:
            return column
    return None


def _group_codes_by_market(codes: list[str]) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = {}
    for raw_code in codes:
        code = str(raw_code).strip().upper()
        if len(code) < 5:
            continue
        grouped.setdefault(code[:4], []).append(code)
    return grouped


def print_response_df(title: str, response):
    print(title)
    if not response:
        print(f"查询失败: {response.error}")
        return None

    df = response.df
    if isinstance(df, pd.DataFrame):
        if df.empty:
            print("没有数据")
        else:
            print(df)
    else:
        print(response.data)
    return df


def run_market_data_example(
    list_loader_name: str,
    query_method_name: str,
    title: str,
    query_key: str = "基础数据",
    sample_size: int | None = None,
):
    with THS() as ths:
        list_response = getattr(ths, list_loader_name)()
        if not list_response:
            print(f"获取列表失败: {list_response.error}")
            return

        list_df = list_response.df
        if not isinstance(list_df, pd.DataFrame) or list_df.empty:
            print("列表接口没有返回可用数据")
            return

        code_column = _pick_code_column(list_df)
        if not code_column:
            print("列表接口返回中缺少代码列")
            return

        codes = list_df[code_column].astype(str).tolist()
        print(f"{title}共加载 {len(codes)} 个代码，准备按 market 分组查询。")

        grouped_codes = _group_codes_by_market(codes)
        if not grouped_codes:
            print("没有可用于查询的有效代码")
            return

        frames: list[pd.DataFrame] = []
        last_non_df_data = None
        success_groups = 0

        for market, market_codes in grouped_codes.items():
            print(f"\n按 market={market} 分组查询，共 {len(market_codes)} 个代码。")
            market_response = getattr(ths, query_method_name)(market_codes, query_key=query_key)
            if not market_response:
                print(f"查询失败 (market={market}): {market_response.error}")
                continue

            success_groups += 1
            df = market_response.df
            if isinstance(df, pd.DataFrame):
                frames.append(df)
            else:
                last_non_df_data = market_response.data

        if not success_groups:
            print("全部分组查询失败")
            return

        if frames:
            merged_df = pd.concat(frames, ignore_index=True)
            print(merged_df)
            print(f"\n查询成功，共返回 {len(merged_df)} 条数据，来自 {success_groups} 个 market 分组。")
            return

        print(last_non_df_data)
