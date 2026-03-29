
import os
import json
import pandas as pd

base = 'd:/PROYECTO-PAPER/Evoviz/NEW_MODEL_DCAE/fusion/data_unida/real_data_pca2'
files = os.listdir(base)
meta = {}
ranges = {}

china_names = {
    "1000": "Aotizhongxin",
    "1001": "Changping",
    "1002": "Dongsi",
    "1003": "Guanyuan",
    "1004": "Gucheng",
    "1005": "Huairou",
    "1006": "Nongzhanguan",
    "1007": "Shunyi",
    "1008": "Tiantan",
    "1009": "Wanliu",
    "1010": "Wanshouxigong",
    "1011": "Dingling"
}

for f in files:
    if not f.endswith('.csv') or 'nan' in f:
        continue
    
    # Path for reading date range
    full_path = os.path.join(base, f)
    
    # Extract country and determine if it's averaged
    if f.startswith('Data_'):
        country = 'China'
    elif '_Averaged' in f:
        country = f.split('_')[0]
    else:
        parts = f.replace('.csv', '').split('_')
        if len(parts) < 2: continue
        country = parts[0]

    # Detect range for this file (we take the first one found for the country)
    if country not in ranges:
        try:
            df_temp = pd.read_csv(full_path, usecols=['year', 'month', 'day'], nrows=1)
            first_date = f"{df_temp.iloc[0]['year']}-{int(df_temp.iloc[0]['month']):02d}-{int(df_temp.iloc[0]['day']):02d}"
            # For max date, we'd need to read the end, but let's assume 2025-12-31 for now or read a few rows from end
            df_end = pd.read_csv(full_path, usecols=['year', 'month', 'day']).tail(1)
            last_date = f"{df_end.iloc[0]['year']}-{int(df_end.iloc[0]['month']):02d}-{int(df_end.iloc[0]['day']):02d}"
            ranges[country] = {"min": first_date, "max": last_date}
        except:
            ranges[country] = {"min": "2019-01-01", "max": "2025-12-31"}

    if '_Averaged' in f:
        # Don't add to station list, it's a special file
        if country not in meta: meta[country] = []
        # We can store the averaged file separately or skip
        continue

    if f.startswith('Data_'):
        name = f.replace('Data_', '').replace('.csv', '')
        s_id = name
        for cid, cname in china_names.items():
            if cname == name:
                s_id = cid
                break
    else:
        parts = f.replace('.csv', '').split('_')
        s_id = parts[1]
        name = f"Station {s_id}"

    if country not in meta:
        meta[country] = []
    
    meta[country].append({
        'id': s_id,
        'name': name,
        'file': f
    })

output = {
    "stations": meta,
    "ranges": ranges,
    "averaged_files": {c: f"{c}_Averaged.csv" for c in ranges.keys()}
}

with open('d:/PROYECTO-PAPER/Evoviz/static/station_meta.json', 'w') as out:
    json.dump(output, out, indent=2)
print("Station metadata updated with date ranges and averaged files.")
