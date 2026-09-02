#!/usr/bin/env python3
import os
from dotenv import load_dotenv
load_dotenv()

from google import genai

api_key = os.getenv("GEMINI_API_KEY")
if api_key:
    client = genai.Client(api_key=api_key)
    
    # Test generating content
    response = client.models.generate_content(
        model="gemini-3.6-flash",
        contents="Hello, how are you?",
    )
    print(f"Response: {response.text}")
