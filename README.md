# Simogura Water Control IoT System API & Dashboard

A professional Node.js API and WebSocket server built for the ESP32 Water Control IoT System. It connects HiveMQ (MQTT Broker) and Supabase (PostgreSQL Database) in real-time, providing both a continuous bridge worker and a serverless deployment pathway for Vercel.

It includes a **premium, glassmorphic real-time web dashboard** served directly by the backend.

---

## 🏗️ System Architecture

```mermaid
graph TD
    ESP32[ESP32 Water Controller] -- MQTT (Port 8883/8884) --> HiveMQ[HiveMQ Cloud Broker]
    
    subgraph Backend Services (server.js)
        MQTT_Sub[MQTT Subscriber] -- Real-Time Broadcast --> WS_Server[WebSocket Server]
        MQTT_Sub -- Write Data --> DB_Save[Supabase Client]
    end
    
    HiveMQ --> MQTT_Sub
    
    subgraph Client Application
        Dashboard[Web Dashboard] -- WebSockets (ws://) --> WS_Server
        Dashboard -- Override Controls (HTTP POST) --> Express_API[Express Rest API]
        Express_API -- Publish command --> HiveMQ
    end
    
    subgraph Database
        DB_Save --> Supabase[(Supabase Database)]
    end
```

### 1. Continuous Mode (`server.js`)
* **Purpose:** Production-grade deployment (e.g. Render, Railway, Fly.io, or VPS) that runs continuously.
* **Functionality:** Maintains a persistent connection to HiveMQ to subscribe to sensor data, stores incoming data to Supabase instantly, and broadcasts telemetry to all connected web dashboards via WebSockets.

### 2. Serverless Mode (`api/index.js` + `vercel.json`)
* **Purpose:** Serverless hosting on **Vercel**.
* **Functionality:** Exposes RESTful API endpoints for retrieving historical data (`GET /api/telemetry`), fetching pool info (`GET /api/pools`), or triggering manual valve overrides (`POST /api/valves`). Also provides a `POST /api/telemetry` webhook receiver to support serverless-driven writes.

---

## ⚡ Quick Start (Local Development)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your Supabase credentials:
```bash
cp .env.example .env
```
Ensure you provide:
* `SUPABASE_URL`: Your Supabase Project API URL.
* `SUPABASE_SERVICE_ROLE_KEY`: Service role API key (bypasses Row-Level Security for backend inserts).
* `DEFAULT_KOLAM_ID`: A valid UUID from your Supabase `kolam` table to map fallback telemetry.

### 3. Run the Server
```bash
npm start
```
* **Express API Server:** [http://localhost:3000](http://localhost:3000)
* **Real-time Web Dashboard:** Served directly at [http://localhost:3000](http://localhost:3000)
* **WebSocket URL:** `ws://localhost:3000`

---

## 📋 Database Setup

Execute the following DDL script in your Supabase SQL Editor to create the necessary tables and relationships:

```sql
-- 1. Accounts Table (Akun)
CREATE TABLE public.akun (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  role text DEFAULT 'Karyawan'::text,
  username text,
  password text,
  lastlogin_at timestamp with time zone DEFAULT now(),
  Nama text,
  CONSTRAINT akun_pkey PRIMARY KEY (id)
);

-- 2. Ponds Table (Kolam)
CREATE TABLE public.kolam (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by bigint,
  alamat text,
  total_ikan bigint,
  target_bobot bigint,
  durasi_target bigint,
  tanggal_mulai date,
  status boolean,
  nama text,
  CONSTRAINT kolam_pkey PRIMARY KEY (id),
  CONSTRAINT kolam_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.akun(id)
);

-- 3. Sensor Data Table (Data Sensor)
CREATE TABLE public.data_sensor (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  ph double precision,
  temp double precision,
  ketinggian real,
  amonia double precision,
  kolam_id uuid,
  CONSTRAINT data_sensor_pkey PRIMARY KEY (id),
  CONSTRAINT data_sensor_kolam_id_fkey FOREIGN KEY (kolam_id) REFERENCES public.kolam(id) ON DELETE CASCADE
);
```

---

## 🔌 API Documentation

### `GET /api/telemetry`
Retrieves recent sensor records.
* **Query Params:**
  * `kolam_id` (optional): Filter results by specific pond UUID.
  * `limit` (optional): Max records to retrieve (default: `20`).
* **Response:** Array of telemetry records.

### `POST /api/telemetry`
Allows manual insertion of telemetry data (ideal for webhooks or HTTP posting).
* **Body (JSON):**
  ```json
  {
    "distance": 12.5,
    "temperature": 27.2,
    "ph_voltage": 2.15,
    "mq_raw": 1120,
    "ammonia": 0.125,
    "kolam_id": "YOUR_KOLAM_UUID"
  }
  ```

### `POST /api/valves`
Publishes valve controls to HiveMQ.
* **Body (JSON):**
  ```json
  {
    "solenoid_in": "OPEN",
    "solenoid_out": "CLOSED",
    "kolam_id": "YOUR_KOLAM_UUID"
  }
  ```

---

## 📡 MQTT Topic Mapping & ESP32 Integration

The bridge is designed to automatically map standard and multi-pond setups:

1. **Fallback (Single Pond):**
   If the ESP32 publishes directly to `water_control/telemetry`, the bridge saves it under the configured `DEFAULT_KOLAM_ID`.

2. **Dynamic (Multi-Pond Routing):**
   To associate telemetry with a specific pond dynamically, configure your ESP32 to publish to a topic that contains the pond's UUID:
   * **Telemetry topic format:** `water_control/<kolam_uuid>/telemetry`
   * **Valve command topic format:** `water_control/<kolam_uuid>/valves`

   *Example in ESP32 code:*
   ```cpp
   // If the pond UUID is: 4f3a8b41-11d2-45e0-819a-24536780c10b
   const char* topic_telemetry = "water_control/4f3a8b41-11d2-45e0-819a-24536780c10b/telemetry";
   ```

---

## 🚀 Deploying to Vercel

Vercel functions are stateless and ephemeral, making them perfect for serving HTTP APIs but unable to host long-running background MQTT listeners or persistent WebSockets directly.

### Steps to Deploy:
1. Install the Vercel CLI: `npm i -g vercel`
2. Run `vercel` in the project root to deploy.
3. Configure your Environment Variables on the Vercel dashboard (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HIVEMQ_HOST`, `HIVEMQ_PORT`, etc.).

> [!TIP]
> To use this system fully serverless on Vercel, use **Supabase Realtime (WebSockets)** on the frontend to subscribe directly to database updates, and configure HiveMQ to forward messages to Vercel via HTTP webhooks using HiveMQ's Webhook extension.
