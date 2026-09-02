#!/usr/bin/env python3
import os
from dotenv import load_dotenv
load_dotenv()

from google import genai 
api_key = os.getenv("GEMINI_API_KEY")
print(f"API Key found: {bool(api_key)}")
print(f"API Key starts with: {api_key[:10] if api_key else 'None'}...")

if api_key:
    genai.configure(api_key=api_key)
    models = genai.list_models()
    print("\nAvailable models:")
    for model in models:
        if "generat" in model.name.lower():  # Only show models that support text generation
            print(f"  - {model.name}")
