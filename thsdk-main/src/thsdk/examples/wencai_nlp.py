from thsdk import THS


# with THS() as ths:
#     response = ths.wencai_nlp("龙头行业;国资委;所属行业")
#     df = response.df
#     print(df)
#
#     time.sleep(1)
#

def main():
    with THS() as ths:
        response = ths.wencai_nlp("龙头行业;国资委;所属行业")
        if not response:
            print(f"查询失败: {response.error}")
            return

        df = response.df

        def complete_code(code):
            if code.endswith(".SH"):
                return f"USHA{code[:6]}"
            if code.endswith(".SZ"):
                return f"USZA{code[:6]}"
            if code.endswith(".BJ"):
                return f"USTM{code[:6]}"
            raise ValueError("Unsupported code format", code)

        df["转换股票代码"] = [complete_code(code) for code in df["股票代码"].astype(str).tolist()]
        print(df)


if __name__ == "__main__":
    main()
