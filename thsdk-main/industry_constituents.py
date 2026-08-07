from thsdk import THS
import pandas as pd
import time
import os

# 创建data文件夹
data_dir = os.path.join(os.path.dirname(__file__), 'data')
if not os.path.exists(data_dir):
    os.makedirs(data_dir)

with THS() as ths:
    # 获取行业信息
    response = ths.block(0xCE5F)
    print("行业信息:")
    if not response:
        print(f"错误信息: {response.error}")
    else:
        industry_df = response.df
        print(industry_df)
        print(f"\n找到 {len(industry_df)} 个行业")
        
        # 存储所有数据
        all_data = []
        
        for idx, row in industry_df.iterrows():
            industry_code = row['代码']
            industry_name = row['名称']
            
            print(f"\n正在获取行业 {industry_name} ({industry_code}) 的成分股...")
            
            try:
                constituent_response = ths.block_constituents(str(industry_code))
                print(f"板块成份股数据:")
                if not constituent_response:
                    print(f"  错误信息: {constituent_response.error}")
                else:
                    constituent_df = constituent_response.df
                    print(f"  成分股数量: {len(constituent_df)}")
                    
                    # 为每一行添加行业信息
                    constituent_df['industry_code'] = industry_code
                    constituent_df['industry_name'] = industry_name
                    
                    all_data.append(constituent_df)
                
                time.sleep(0.5)  # 防止请求过快
                
            except Exception as e:
                print(f"  获取 {industry_name} 成分股失败: {str(e)}")
                time.sleep(0.5)
        
        # 按行业分组整理数据
        if all_data:
            merged_df = pd.concat(all_data, ignore_index=True)
            print(f"\n\n总共获取到 {len(merged_df)} 条成分股数据")
            
            # 按行业分组，将成分股代码用逗号分隔到一个单元中
            if 'code' in merged_df.columns:
                stock_code_column = 'code'
            elif '代码' in merged_df.columns:
                stock_code_column = '代码'
            else:
                stock_code_column = merged_df.columns[0]
            
            # 按行业分组汇总
            industry_summary = merged_df.groupby('industry_code').agg({
                'industry_name': 'first',
                stock_code_column: lambda x: ','.join(x.astype(str))
            }).reset_index()
            
            # 重命名列
            industry_summary.rename(columns={stock_code_column: 'constituents'}, inplace=True)
            industry_summary.rename(columns={'industry_code': '行业代码', 'industry_name': '行业名称', 'constituents': '成分股'}, inplace=True)
            
            # 保存到CSV文件
            output_file = os.path.join(data_dir, 'industry_constituents.csv')
            industry_summary.to_csv(output_file, index=False, encoding='utf-8-sig')
            print(f"数据已保存到: {output_file}")
            
            print("\n整理后的数据：")
            print(industry_summary)
        else:
            print("未获取到任何成分股数据")
