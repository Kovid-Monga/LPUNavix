#!/usr/bin/env python3
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

load_dotenv()
from google import genai

api_key = os.getenv("GEMINI_API_KEY")
print(f"API Key found: {bool(api_key)}")

if api_key:
    client = genai.Client(api_key=api_key)
    print("\nListing available models:")
    try:
        for model in client.models.list():
            print(f"  - {model.name}")
    except Exception as e:
        print(f"Error listing models: {e}")

