#!/usr/bin/env python3
import os
from dotenv import load_dotenv
load_dotenv()

import google.generativeai as genai
api_key = os.getenv("GEMINI_API_KEY")

if api_key:
    genai.configure(api_key=api_key)
    models = genai.list_models()
    print("ALL available models:")
    for model in models:
        print(f"  - {model.name}")
        if hasattr(model, 'supported_generation_methods'):
            print(f"    Methods: {model.supported_generation_methods}")
