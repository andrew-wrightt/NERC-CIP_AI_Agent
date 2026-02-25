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

1. Clone the repository
2. Navigate to the ui folder: `cd ui`
3. Install dependencies: `npm install`
4. Start the application: `npm start`
5. Open http://localhost:5173 in your browser

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

## Security Notes

For production:
- Change the JWT_SECRET
- Use HTTPS
- Replace in-memory storage with a real database
- Change default admin credentials
