# Backend configuration for Terraform state
# Using Terraform Cloud for remote state management

terraform {
  cloud {
    organization = "josejalvarezmterraform"
    
    workspaces {
      name = "cv-admin-worker"
    }
  }
}
