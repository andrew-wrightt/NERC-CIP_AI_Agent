# NERC-CIP AI Agent

A secure, compliance-focused AI assistant for querying NERC-CIP (North American Electric Reliability Corporation - Critical Infrastructure Protection) standards and documentation.

## Features

### Authentication & Access Control
- User registration and login system
- Role-based access control with two roles:
  - **Operator** - Can use the AI chat to query documents
  - **Admin** - Can chat, upload/delete documents, and manage users
- Passwords hashed with bcrypt
- JWT session tokens with 2-hour timeout
- Account lockout after 5 failed login attempts

### AI-Powered Document Q&A
- RAG (Retrieval-Augmented Generation) for accurate answers
- Automatic PDF indexing
- Admins can upload additional documents
- Responses include source citations

### Automated Compliance Document Ingestion
- **Scraping Pipeline (#113)**: Automatically discovers and downloads NERC-CIP standard PDFs from configurable source URLs. Supports manifest-based change tracking with etag/last-modified/SHA-256 deduplication.
- **Document Change Watcher (#114)**: Monitors public/, uploads/, and scraped/ directories for new, modified, or deleted documents. Automatically triggers re-ingestion when changes are detected. Configurable polling interval.
- Admin panel "Document Ingestion" tab for manual scrape triggers, manifest inspection, watcher status, and change history.

### Admin Panel
- User management (create, edit, delete users)
- Audit logging for all actions
- System status and compliance info

### NERC-CIP Compliance
Implements security controls aligned with:
- CIP-004 (Personnel & Training)
- CIP-007 (System Security Management)

## Tech Stack

- Backend: Node.js, Express
- AI/ML: Ollama (local LLM), nomic-embed-text (embeddings)
- Authentication: JWT, bcrypt
- Frontend: Vanilla HTML/CSS/JavaScript

## Prerequisites

- Node.js (v18 or higher)
- Ollama running locally with mistral:instruct and nomic-embed-text models

## Installation

git clone https://github.com/andrew-wrightt/NERC-CIP_AI_Agent.git
cd NERC-CIP_AI_Agent

nvidia-smi (run to verify GPU listed)
enable gpu usage (check tags on Docker Hub)
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi 

docker run -d --name ollama --gpus all -p 11434:11434 -v ollama:/root/.ollama ollama/ollama:latest

docker exec -it ollama ollama pull mistral:instruct

docker exec -it ollama ollama pull nomic-embed-text

docker exec -it ollama ollama list

docker exec -it ollama ollama run mistral:instruct "Say 'GPU test ok' and nothing else." (sanity check)

docker compose up -d --build

to stop:
docker stop ollama
docker compose down


run in /ui:
npm install bcrypt
npm install better-sqlite3
npm install express-session
npm install connect-sqlite3

create ui/data, ui/uploads, and ui/cache

create uname and password: docker compose exec ui node scripts/create-admin.js admin MySecurePassword

## Default Login

- Username: admin
- Password: admin123

Change the default password in production!

## Project Structure

- ui/server.js - Main Express server and RAG logic
- ui/adminRoutes.js - Authentication and user management API
- ui/public/index.html - Main app (login and chat)
- ui/public/app.js - Frontend JavaScript
- ui/public/styles.css - Styling
- ui/public/admin/ - Admin panel files

## Environment Variables

- OLLAMA_URL - Ollama API URL (default: http://localhost:11434)
- JWT_SECRET - JWT signing secret (change in production!)
- SCRAPE_SOURCES - Comma-separated list of URLs to scrape for CIP PDFs (optional, has built-in defaults)
- WATCH_INTERVAL_MS - Document watcher polling interval in milliseconds (default: 300000 = 5 min)
- DISABLE_WATCHER - Set to "true" to disable the automatic document change watcher
- SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM - Email config for MFA QR code delivery
- MFA_ISSUER - Name shown in authenticator apps (default: "NERC-CIP AI Agent")

## Security Notes

For production:
- Change the JWT_SECRET
- Use HTTPS
- Replace in-memory storage with a real database
- Change default admin credentials
