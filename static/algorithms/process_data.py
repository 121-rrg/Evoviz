
import pandas as pd
import numpy as np
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.cluster import KMeans
import umap
import os

def calculate_aqi(row):
    # Simplified AQI calculation (max of normalized pollutants if possible, 
    # but here we use the max concentration as a proxy for the index source)
    pollutants = ['PM25_Concentration', 'PM10_Concentration', 'NO2_Concentration', 
                  'CO_Concentration', 'O3_Concentration', 'SO2_Concentration']
    values = []
    for p in pollutants:
        if p in row and not pd.isna(row[p]):
            values.append(row[p])
    if not values:
        return 0
    return max(values)

def process_country(country_name, aq_file, meteo_file, station_file, embedding_file, output_base):
    print(f"Processing {country_name}...")
    
    try:
        aq_df = pd.read_csv(aq_file)
        meteo_df = pd.read_csv(meteo_file)
        station_df = pd.read_csv(station_file)
        embeddings = pd.read_csv(embedding_file)
    except Exception as e:
        print(f"Error loading files for {country_name}: {e}")
        return

    # 1. Aling AQ data with Embeddings (Assuming embeddings are grouped by station then time)
    aq_df['time'] = pd.to_datetime(aq_df['time'])
    # Sort to ensure station grouping
    aq_df = aq_df.sort_values(['station_id', 'time']).reset_index(drop=True)
    embeddings = embeddings.reset_index(drop=True)

    if len(aq_df) != len(embeddings):
        print(f"Warning: Data length mismatch for {country_name} ({len(aq_df)} vs {len(embeddings)}). Truncating.")
        min_len = min(len(aq_df), len(embeddings))
        aq_df = aq_df.iloc[:min_len]
        embeddings = embeddings.iloc[:min_len]

    # Combine AQ and Embeddings immediately
    # Find start col for numeric embeddings
    start_col = 0
    for i, col in enumerate(embeddings.columns):
        if col.isdigit() or col == '0' or col == '0.1' or col.startswith('emb_'):
            start_col = i
            break
    emb_data = embeddings.iloc[:, start_col:].values
    
    # 2. Dimensionality Reduction & Clustering on joined data
    print("Performing Dimensionality Reduction and Clustering...")
    # KMeans
    for k in [3, 4, 6, 12]:
        print(f"  Clustering K={k}...")
        kmeans = KMeans(n_clusters=k, random_state=42, n_init=10)
        aq_df[f'Kmeans_{k}'] = kmeans.fit_predict(emb_data)
        aq_df[f'HDBSCAN_{k}'] = aq_df[f'Kmeans_{k}'] # Placeholder

    # PCA
    print("  Calculating PCA...")
    pca = PCA(n_components=2)
    pca_result = pca.fit_transform(emb_data)
    aq_df['PCA1'] = pca_result[:, 0]
    aq_df['PCA2'] = pca_result[:, 1]
    
    # UMAP
    print("  Calculating UMAP...")
    try:
        from umap import UMAP
        reducer = UMAP(n_components=2, random_state=42, n_neighbors=15, min_dist=0.1)
        umap_result = reducer.fit_transform(emb_data)
        aq_df['UMAP1'] = umap_result[:, 0]
        aq_df['UMAP2'] = umap_result[:, 1]
    except Exception as e:
        print(f"  UMAP calculation failed: {e}. Using PCA as proxy.")
        aq_df['UMAP1'] = aq_df['PCA1']
        aq_df['UMAP2'] = aq_df['PCA2']
    
    # TSNE
    print("  Calculating t-SNE...")
    # Using standard TSNE as requested
    tsne = TSNE(n_components=2, random_state=42)
    tsne_result = tsne.fit_transform(emb_data)
    aq_df['TSNE1'] = tsne_result[:, 0]
    aq_df['TSNE2'] = tsne_result[:, 1]

    # 3. Merge with Station and Meteorology
    if 'id' in station_df.columns:
        station_df.rename(columns={'id': 'station_id'}, inplace=True)
    
    # Add station metadata
    final_df = pd.merge(aq_df, station_df, on='station_id', how='left')
    
    # Prepare meteorology (daily average)
    meteo_df['time'] = pd.to_datetime(meteo_df['time'])
    meteo_df['date'] = meteo_df['time'].dt.date
    if 'id' in meteo_df.columns:
        meteo_df.rename(columns={'id': 'district_id'}, inplace=True)
    
    meteo_daily = meteo_df.groupby(['district_id', 'date']).mean(numeric_only=True).reset_index()
    
    # Merge with final_df
    final_df['date'] = final_df['time'].dt.date
    final_df = pd.merge(final_df, meteo_daily, on=['district_id', 'date'], how='left')

    # 4. Final Processing
    final_df['year'] = final_df['time'].dt.year
    final_df['month'] = final_df['time'].dt.month
    final_df['day'] = final_df['time'].dt.day
    final_df['AQI'] = final_df.apply(calculate_aqi, axis=1)
    
    column_mapping = {
        'PM25_Concentration': 'PM2_5',
        'PM10_Concentration': 'PM10',
        'SO2_Concentration': 'SO2',
        'NO2_Concentration': 'NO2',
        'CO_Concentration': 'CO',
        'O3_Concentration': 'O3',
        'temperature': 'TEMP',
        'pressure': 'PRES',
        'humidity': 'DEWP',
        'wind_speed': 'WSPM',
        'station_id': 'station'
    }
    
    final_df.rename(columns=column_mapping, inplace=True)
    if 'RAIN' not in final_df.columns:
        final_df['RAIN'] = 0
    
    final_df['station'] = final_df['station'].astype(int)
    final_df['city'] = final_df['station'].apply(lambda x: f"{country_name}_{x}.csv")
            
    # 8. Save Data for each dimensionality reduction technique
    techniques = ['pca2', 'tsne2', 'umap2']
    bases = ['fusion', 'contaminantes', 'meteorologicos']
    
    unique_stations = final_df['station'].unique()
    
    for tech in techniques:
        print(f"  Saving results for {tech}...")
        for base in bases:
            tech_folder = f"{base}/data_unida/real_data_{tech}"
            out_path = os.path.join(output_base, tech_folder)
            os.makedirs(out_path, exist_ok=True)
            
            # Save individual stations
            for s_id in unique_stations:
                station_df = final_df[final_df['station'] == s_id]
                filename = f"{country_name}_{s_id}.csv"
                station_df.to_csv(os.path.join(out_path, filename), index=False)
                
            # Save Averaged Country data
            avg_filename = f"{country_name}_Averaged.csv"
            country_avg = final_df.groupby('time').mean(numeric_only=True).reset_index()
            country_avg['station'] = 0
            country_avg['city'] = f"{country_name}_Averaged.csv"
            country_avg['year'] = country_avg['time'].dt.year
            country_avg['month'] = country_avg['time'].dt.month
            country_avg['day'] = country_avg['time'].dt.day
            country_avg.to_csv(os.path.join(out_path, avg_filename), index=False)
            
    print(f"Finished {country_name}. Stations: {len(unique_stations)}")
    return final_df

if __name__ == "__main__":
    base_data = "d:/PROYECTO-PAPER/Evoviz/NEW-DATA/DATA"
    base_emb = "d:/PROYECTO-PAPER/Evoviz/NEW-DATA/EMBEDDINGS"
    output_base = "d:/PROYECTO-PAPER/Evoviz/NEW_MODEL_DCAE"
    
    countries = {
        'China': ('ImputAQ/air_quality_china.csv', 'Meteo/meteorology_china.csv', 'Station/station_china.csv', 'air_quality_china/embeddings_allrows.csv'),
        'USA': ('ImputAQ/air_quality_usa.csv', 'Meteo/meteorology_usa.csv', 'Station/station_usa.csv', 'air_quality_usa/embeddings_allrows.csv'),
        'India': ('ImputAQ/air_quality_india.csv', 'Meteo/meteorology_india.csv', 'Station/station_india.csv', 'air_quality_india/embeddings_allrows.csv'),
        'Peru': ('ImputAQ/air_quality_peru.csv', 'Meteo/meteorology_peru.csv', 'Station/station_peru.csv', 'air_quality_peru/embeddings_allrows.csv'),
    }
    
    all_country_data = []
    for country, files in countries.items():
        res = process_country(
            country,
            os.path.join(base_data, files[0]),
            os.path.join(base_data, files[1]),
            os.path.join(base_data, files[2]),
            os.path.join(base_emb, files[3]),
            output_base
        )
        if res is not None:
            all_country_data.append(res)
    
    if all_country_data:
        full_df = pd.concat(all_country_data, ignore_index=True)
        techniques = ['pca2', 'tsne2', 'umap2']
        for tech in techniques:
            # Match naming with HTML: tnse instead of tsne
            name_part = tech.replace('2', '')
            if name_part == 'tsne': name_part = 'tnse'
            filename = f"{name_part}_unido_promediado2.csv"
            out_path = os.path.join(output_base, f"fusion/data_unida/{filename}")
            full_df.to_csv(out_path, index=False)
            print(f"Saved global joined file: {out_path}")
