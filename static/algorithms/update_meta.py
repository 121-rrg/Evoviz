
import os
import json
import pandas as pd

base_path = 'd:/PROYECTO-PAPER/Evoviz/NEW_MODEL_DCAE/fusion/data_unida/real_data_pca2/'
meta_file = 'd:/PROYECTO-PAPER/Evoviz/static/station_meta.json'

countries = ["China", "India", "USA", "Peru"]
data = {
    "stations": {},
    "ranges": {},
    "averaged_files": {}
}

for country in countries:
    data["stations"][country] = []
    # Filter files for the specific country
    files = [f for f in os.listdir(base_path) if f.startswith(f"{country}_") and f.endswith(".csv") and "Averaged" not in f]
    
    for f in sorted(files):
        # Format is Country_ID.csv
        parts = f.replace(".csv", "").split("_")
        if len(parts) >= 2:
            s_id = parts[1]
            s_name = f"{country} Station {s_id}"
            
            data["stations"][country].append({
                "id": s_id,
                "name": s_name,
                "file": f
            })

    if data["stations"][country]:
        data["ranges"][country] = {"min": "2019-01-01", "max": "2025-12-31"}
        data["averaged_files"][country] = f"{country}_Averaged.csv"

with open(meta_file, 'w') as j:
    json.dump(data, j, indent=2)

print("station_meta.json updated successfully with generic names.")
