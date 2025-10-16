# NERC-CIP_AI_Agent
This will serve as a repository for Capstone I/II at ASU. Our goal is to create an AI Agent that is self-hosted and uses RAG to help the team meet compliance standards, answer procedural questions, and generally help with day to day work. The agent will use a UI to interact with/adjust users and knowledge base. 

In order to test this on your machine:
1. Download Docker Desktop 
  Windows: https://www.docker.com/products/docker-desktop/
  Mac: https://docs.docker.com/desktop/setup/install/mac-install/

2. Ensure Git is installed
   Windows: run git --version in Command Prompt or Powershell
   Mac: Automatically installed

3. Clone the repo and navigate to it
   Run these commands:
     git clone https://github.com/andrew-wrightt/NERC-CIP_AI_Agent.git
     cd NERC-CIP_AI_Agent
   Windows: Powershell or Git Bash
   Mac: Terminal

4. Start stack with Docker
   run: docker compose up -d --build

5. Once started you can visit http://localhost:5173 to interact with the LLM through our UI.
   NOTE: LLMs take time to "warm up". We recommend waiting a few minutes before starting queries.

6. To stop the service:
   docker compose down

   
