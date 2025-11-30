terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
  required_version = ">= 1.0"
}

provider "cloudflare" {
  # Credentials will be read from environment variables:
  # CLOUDFLARE_API_TOKEN
}
