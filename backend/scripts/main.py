import PyPDF2
import os
import fitz  # PyMuPDF for better PDF handling
from PIL import Image
import pytesseract
import io
import subprocess
import sys
import json

def find_tesseract_path():
    """Find Tesseract installation path."""
    # Common installation paths on Windows
    common_paths = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        r"C:\Users\{}\AppData\Local\Programs\Tesseract-OCR\tesseract.exe".format(os.getenv('USERNAME')),
        r"C:\tesseract\tesseract.exe"
    ]
    
    # Check if tesseract is in PATH
    try:
        result = subprocess.run(['tesseract', '--version'], 
                            capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            return 'tesseract'  # Found in PATH
    except:
        pass
    
    # Check common installation paths
    for path in common_paths:
        if os.path.exists(path):
            return path
    
    return None

def check_tesseract_installed():
    """Check if Tesseract is installed and accessible."""
    tesseract_path = find_tesseract_path()
    if tesseract_path:
        try:
            if tesseract_path == 'tesseract':
                result = subprocess.run(['tesseract', '--version'], 
                                    capture_output=True, text=True, timeout=5)
            else:
                result = subprocess.run([tesseract_path, '--version'], 
                                    capture_output=True, text=True, timeout=5)
            return result.returncode == 0
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
            pass
    return False

def extract_text_from_pdf(pdf_path):
    """Extract text from a PDF file using PyPDF2."""
    try:
        with open(pdf_path, 'rb') as file:
            pdf_reader = PyPDF2.PdfReader(file)
            text = ""
            
            # Extract text from each page
            for page_num in range(len(pdf_reader.pages)):
                page = pdf_reader.pages[page_num]
                text += page.extract_text() + "\n"
                
            return text
    except Exception as e:
        print(f"Error extracting text from {pdf_path}: {e}")
        return None

def extract_text_with_ocr(pdf_path):
    """Extract text from a PDF file using OCR (Tesseract)."""
    try:
        # Find and set Tesseract path
        tesseract_path = find_tesseract_path()
        if not tesseract_path:
            error_msg = "Tesseract OCR is not installed or not accessible."
            print(f"ERROR: {error_msg}")
            print("To install Tesseract OCR:")
            print("1. Download from: https://github.com/UB-Mannheim/tesseract/wiki")
            print("2. Install and add to PATH")
            print("3. Restart your terminal/command prompt")
            return None, error_msg
        
        # Set the Tesseract path for pytesseract
        if tesseract_path != 'tesseract':
            pytesseract.pytesseract.tesseract_cmd = tesseract_path
            print(f"Using Tesseract at: {tesseract_path}")
        
        # Open PDF with PyMuPDF
        pdf_document = fitz.open(pdf_path)
        ocr_text = ""
        
        print(f"Processing {pdf_path} with OCR...")
        
        for page_num in range(len(pdf_document)):
            page = pdf_document.load_page(page_num)
            
            # Convert page to image
            mat = fitz.Matrix(2, 2)  # Scale factor for better OCR
            pix = page.get_pixmap(matrix=mat)
            
            # Convert to PIL Image
            img_data = pix.tobytes("png")
            img = Image.open(io.BytesIO(img_data))
            
            # Perform OCR
            page_text = pytesseract.image_to_string(img)
            ocr_text += f"--- Page {page_num + 1} ---\n"
            ocr_text += page_text + "\n\n"
            
            print(f"  Processed page {page_num + 1}")
        
        pdf_document.close()
        return ocr_text, None
        
    except Exception as e:
        error_msg = f"Error performing OCR on {pdf_path}: {e}"
        print(error_msg)
        return None, error_msg

def needs_ocr(pdf_path):
    """Check if a PDF needs OCR by attempting to extract text normally first."""
    try:
        # Try normal text extraction
        text = extract_text_from_pdf(pdf_path)
        
        # If text is empty or very short, it likely needs OCR
        if text is None or len(text.strip()) < 50:
            return True
        return False
    except:
        return True

def save_text_to_file(text, output_file):
    """Save extracted text to a file."""
    try:
        with open(output_file, 'w', encoding='utf-8') as file:
            file.write(text)
        print(f"Text successfully saved to {output_file}")
        return True
    except Exception as e:
        print(f"Error saving text to {output_file}: {e}")
        return False

def main():
    # Accept PDF file path and optional output file path as arguments
    if len(sys.argv) < 2:
        print("Usage: python main.py <pdf_path> [output_file]")
        sys.exit(1)
    pdf_path = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(pdf_path), 'output.txt')

    all_text = ""
    ocr_text = ""
    error_details = {}

    # Check Tesseract availability at startup
    tesseract_path = find_tesseract_path()
    tesseract_available = check_tesseract_installed()

    if tesseract_available:
        print(f"Tesseract found and available for OCR processing")
        if tesseract_path != 'tesseract':
            print(f"Tesseract path: {tesseract_path}")
    else:
        print("WARNING: Tesseract OCR is not installed or not accessible.")
        print("To enable OCR functionality, install Tesseract from:")
        print("https://github.com/UB-Mannheim/tesseract/wiki")
        print("Common installation paths checked:")
        print("- C:\\Program Files\\Tesseract-OCR\\")
        print("- C:\\Program Files (x86)\\Tesseract-OCR\\")
        print("- User AppData folder")
        print()

    if os.path.exists(pdf_path):
        print(f"Processing {pdf_path}...")
        # Check if OCR is needed
        if needs_ocr(pdf_path):
            if tesseract_available:
                print(f"{pdf_path} requires OCR processing...")
                text, ocr_error = extract_text_with_ocr(pdf_path)
                if ocr_error:
                    error_details['ocr_error'] = ocr_error
                    print(f"OCR failed: {ocr_error}")
                    sys.exit(3)  # OCR error code
                
                if text and len(text.strip()) >= 50:
                    ocr_text += text
                    print(f"Successfully extracted OCR text from {pdf_path}")
                else:
                    error_msg = f"Failed to extract meaningful OCR text from {pdf_path}. Please try a higher-quality scan."
                    error_details['ocr_quality'] = error_msg
                    print(error_msg)
                    sys.exit(4)  # OCR quality error code
            else:
                error_msg = f"{pdf_path} appears to need OCR but Tesseract is not available."
                error_details['tesseract_missing'] = error_msg
                print(error_msg)
                print(f"Skipping OCR processing for {pdf_path}")
                sys.exit(5)  # Tesseract missing error code
        else:
            print(f"{pdf_path} can be processed normally...")
            text = extract_text_from_pdf(pdf_path)
            if text and len(text.strip()) >= 50:
                all_text += text
                print(f"Successfully extracted text from {pdf_path}")
            else:
                error_msg = f"Failed to extract meaningful text from {pdf_path}. The PDF may be empty or scanned as images."
                error_details['text_extraction'] = error_msg
                print(error_msg)
                sys.exit(6)  # Text extraction error code
    else:
        error_msg = f"File {pdf_path} not found"
        error_details['file_not_found'] = error_msg
        print(error_msg)
        sys.exit(7)  # File not found error code

    # Save normal text to output file
    if all_text:
        if not save_text_to_file(all_text, output_file):
            error_details['file_save'] = "Failed to save extracted text to file"
            sys.exit(8)  # File save error code
            
        print(f"Text extraction completed successfully!")
        print(f"Extracted text saved to: {output_file}")
            
    elif ocr_text:
        if not save_text_to_file(ocr_text, output_file):
            error_details['file_save'] = "Failed to save OCR text to file"
            sys.exit(8)  # File save error code
            
        print(f"OCR text extraction completed successfully!")
        print(f"Extracted OCR text saved to: {output_file}")
    else:
        error_msg = "No text was extracted from the PDF file"
        error_details['no_text'] = error_msg
        print(error_msg)
        sys.exit(10)  # No text extracted error code

    # If we get here, everything succeeded
    print("PDF processing completed successfully!")
    sys.exit(0)

if __name__ == "__main__":
    main()