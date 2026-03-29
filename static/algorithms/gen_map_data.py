
import pandas as pd
import os

base = 'd:/PROYECTO-PAPER/Evoviz/NEW_MODEL_DCAE/fusion/data_unida/real_data_pca2'
output_file = 'd:/PROYECTO-PAPER/Evoviz/data/Data_Map_AQI_Day.csv'

china_names = {
    1000: "Aotizhongxin",
    1001: "Changping",
    1002: "Dongsi",
    1003: "Guanyuan",
    1004: "Gucheng",
    1005: "Huairou",
    1006: "Nongzhanguan",
    1007: "Shunyi",
    1008: "Tiantan",
    1009: "Wanliu",
    1010: "Wanshouxigong",
    1011: "Dingling"
}

files = [f for f in os.listdir(base) if f.endswith('.csv') and '_Averaged' not in f and 'nan' not in f]
all_data = []

for f in files:
    path = os.path.join(base, f)
    try:
        df = pd.read_csv(path)
        # Add missing map columns if needed
        if 'latitude' not in df.columns: df['latitude'] = 0
        if 'longitude' not in df.columns: df['longitude'] = 0
        
        sid = df['station'].iloc[0]
        if 'Data_' in f:
            name = china_names.get(int(sid), f.replace('Data_','').replace('.csv',''))
        else:
            name = f.split('_')[0] + " " + str(sid)
            
        df['Notes'] = name
        df['stationId'] = name
        
        # Keep only what JS expects for Map
        needed = ['stationId', 'latitude', 'longitude', 'year', 'month', 'day', 'AQI', 'Notes']
        all_data.append(df[[c for c in needed if c in df.columns]])
    except Exception as e:
        print(f"Skipping {f}: {e}")
        continue

if all_data:
    final_map_df = pd.concat(all_data)
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    final_map_df.to_csv(output_file, index=False)
    print(f"Map data generated at {output_file} with {len(final_map_df)} rows")
