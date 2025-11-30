# Backend configuration for Terraform state
# 
# Option 1: Local state (default, for now)
# State is stored in terraform.tfstate locally
#
# Option 2: Terraform Cloud (recommended for team/CI)
# Uncomment the cloud block below:
#
# terraform {
#   cloud {
#     organization = "josejalvarezmterraform"
#     
#     workspaces {
#       name = "cv-admin-worker"
#     }
#   }
# }
#
# Option 3: Remote backend (R2/S3)
# terraform {
#   backend "s3" {
#     bucket         = "cv-terraform-state"
#     key            = "cv-admin-worker/terraform.tfstate"
#     region         = "auto"
#     endpoint       = "https://<account_id>.r2.cloudflarestorage.com"
#     skip_credentials_validation = true
#     skip_metadata_api_check     = true
#   }
# }
