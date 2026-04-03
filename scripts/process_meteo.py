import os
import pandas as pd
import glob
import re

# Paths
DATA_METEOROLOGICA = r'D:\PROYECTO-PAPER\Evoviz\NEW-DATA\data_meteorologica'
STATION_MAPPING_PATH = r'D:\PROYECTO-PAPER\Evoviz\NEW-DATA\DATA\Station'
OUTPUT_METEO_PATH = r'D:\PROYECTO-PAPER\Evoviz\NEW-DATA\DATA\Meteo'

def process_country(country):
    print(f"Processing {country}...")
    country_lower = country.lower()
    
    # Load station to district mapping
    mapping_file = os.path.join(STATION_MAPPING_PATH, f'station_{country_lower}.csv')
    if not os.path.exists(mapping_file):
        print(f"  Mapping file not found: {mapping_file}")
        return
    
    mapping_df = pd.read_csv(mapping_file)
    id_to_district = dict(zip(mapping_df['station_id'], mapping_df['district_id']))
    
    # Files for the country
    country_dir = os.path.join(DATA_METEOROLOGICA, country)
    if not os.path.exists(country_dir):
        print(f"  Directory not found: {country_dir}")
        return
        
    csv_files = glob.glob(os.path.join(country_dir, "*.csv"))
    all_rows = []
    
    for f in csv_files:
        # Extract station_id from filename (e.g. 1000-beijing.csv -> 1000)
        fname = os.path.basename(f)
        match = re.search(r'(\d+)', fname)
        if not match:
            print(f"  Could not extract ID from {fname}")
            continue
        station_id = int(match.group(1))
        
        if station_id not in id_to_district:
            # print(f"  Station {station_id} not in mapping")
            continue
            
        district_id = id_to_district[station_id]
        
        # Read the CSV. Open-Meteo format has metadata at top.
        # Find the line where "time" header starts.
        with open(f, 'r') as fh:
            lines = fh.readlines()
            header_idx = -1
            for i, line in enumerate(lines):
                if line.startswith('time,'):
                    header_idx = i
                    break
        
        if header_idx == -1:
            print(f"  Could not find header in {fname}")
            continue
            
        df = pd.read_csv(f, skiprows=header_idx)
        
        # Identify columns
        # Expected: time, temperature_2m (°C), wind_speed_10m (km/h), relative_humidity_2m (%), precipitation (mm), pressure_msl (hPa), wind_direction_10m (°)
        # Let's map dynamically
        col_map = {}
        for c in df.columns:
            clow = c.lower()
            if 'time' in clow: col_map['time'] = c
            elif 'temperature' in clow: col_map['temp'] = c
            elif 'wind_speed' in clow: col_map['wind_speed'] = c
            elif 'humidity' in clow: col_map['humidity'] = c
            elif 'precipitation' in clow: col_map['rain'] = c
            elif 'pressure' in clow: col_map['pressure'] = c
            elif 'wind_direction' in clow: col_map['wind_direction'] = c
            
        # Ensure minimum columns
        required = ['time', 'temp', 'humidity']
        if not all(r in col_map for r in required):
            print(f"  Missing required columns in {fname}: {col_map}")
            continue
            
        # Parse time
        df[col_map['time']] = pd.to_datetime(df[col_map['time']])
        df['date'] = df[col_map['time']].dt.date
        
        # Resample logic (group by date)
        # Precipitation: SUM
        # Others: MEAN
        
        agg_map = {
            col_map['temp']: 'mean',
            col_map['humidity']: 'mean'
        }
        if 'pressure' in col_map: agg_map[col_map['pressure']] = 'mean'
        if 'wind_speed' in col_map: agg_map[col_map['wind_speed']] = 'mean'
        if 'wind_direction' in col_map: agg_map[col_map['wind_direction']] = 'mean'
        if 'rain' in col_map: agg_map[col_map['rain']] = 'sum'
        
        daily = df.groupby('date').agg(agg_map).reset_index()
        
        # Format output row by row
        for _, row in daily.iterrows():
            out_row = {
                'id': station_id,
                'time': f"{row['date']} 00:00:00",
                'temperature': round(row[col_map['temp']], 2),
                'pressure': round(row[col_map['pressure']], 2) if 'pressure' in col_map else 0.0,
                'humidity': round(row[col_map['humidity']], 2),
                'wind_speed': round(row[col_map['wind_speed']] / 3.6, 2) if 'wind_speed' in col_map else 0.0, # km/h to m/s
                'weather': 1, # Default
                'rain': round(row[col_map['rain']], 2) if 'rain' in col_map else 0.0,
                'wind_direction': round(row[col_map['wind_direction']], 2) if 'wind_direction' in col_map else 0.0
            }
            all_rows.append(out_row)
            
    if not all_rows:
        print(f"  No data processed for {country}")
        return
        
    final_df = pd.DataFrame(all_rows)
    output_file = os.path.join(OUTPUT_METEO_PATH, f'meteorology_{country_lower}.csv')
    
    # Reorder columns to target format
    cols = ['id', 'time', 'temperature', 'pressure', 'humidity', 'wind_speed', 'rain', 'weather', 'wind_direction']
    final_df = final_df[cols]
    
    final_df.to_csv(output_file, index=False)
    print(f"  Saved {len(final_df)} rows to {output_file}")

# Process all countries
for c in ['China', 'India', 'Peru', 'USA']:
    process_country(c)
