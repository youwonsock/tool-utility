#pragma once

#include "CoreMinimal.h"

struct FBX_EXPORTER_API FFBXExporterOptions
{
	FString OutputRoot;
	int32 BakeResolution = 2048;
	bool bReuseDirectTextures = true;
};

struct FBX_EXPORTER_API FFBXExporterResult
{
	bool bSuccess = false;
	FString FinalDirectory;
	TArray<FString> Warnings;
	TArray<FString> Errors;

	bool Succeeded() const
	{
		return bSuccess && Errors.IsEmpty();
	}
};
