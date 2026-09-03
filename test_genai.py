#!/usr/bin/env python3
import os
import sys
from dotenv import load_dotenv

if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

load_dotenv()
from google import genai

api_key = os.getenv("GEMINI_API_KEY")
if api_key:
    client = genai.Client(api_key=api_key)
    
    # Test generating content with gemini-3.7-flash
    response = client.models.generate_content(
        model="gemini-3.7-flash",
        contents="Hello! Give a brief 1-line greeting for LPUNavix campus navigation.",
    )
    print(f"Response: {response.text.strip()}")

