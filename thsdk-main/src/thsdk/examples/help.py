from thsdk import THS

with THS() as ths:
    print("\n=== help doc ===")
    print(ths.help("doc"))
